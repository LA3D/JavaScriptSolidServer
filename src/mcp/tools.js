/**
 * MCP tool definitions and dispatch.
 *
 * Each tool is a function: (args, ctx) -> Promise<MCPToolResult>
 * ctx.webId — authenticated identity (null = anonymous)
 * ctx.origin — request origin for building absolute URLs
 *
 * All WAC checks delegate to src/wac/checker.js so MCP tools have
 * the same access semantics as the HTTP endpoints.
 */

import * as storage from '../storage/filesystem.js';
import { AccessMode, parseAcl, serializeAcl } from '../wac/parser.js';
import { resourceEvents, emitChange } from '../notifications/events.js';
import { toolText, toolError, toolJson } from './protocol.js';
import { admissionError } from './errors.js';
import { applyLwsWrite } from '../lws/write.js';
import { collectAuthorizedResources } from '../lws/authorized-resources.js';
import { parseFilter, matchesFilter, containerItemTypes } from '../lws/type-index.js';
import { generateLinkset } from '../lws/linkset.js';
import { readDeclaredTypes } from '../lws/type-metadata.js';
import { describedbyTargets, conformsToTargets } from '../lws/constraint.js';
import { readAuthorizedRepresentations } from '../lws/representations.js';
import { wac, buildUrl, parentPath } from './wac.js';
import { sanitizeTypes } from './sanitize.js';
import { readBounded, sanitizeForTrust } from './read.js';
import { read_resource, list_resources } from './read-tools.js';
import { isLocalUri, uriToPath } from './uri.js';

const ACL_NS = 'http://www.w3.org/ns/auth/acl#';
const FOAF_AGENT = 'http://xmlns.com/foaf/0.1/Agent';
const ACL_AUTH_AGENT = 'http://www.w3.org/ns/auth/acl#AuthenticatedAgent';
const FULL_MODE = {
  Read: `${ACL_NS}Read`,
  Write: `${ACL_NS}Write`,
  Append: `${ACL_NS}Append`,
  Control: `${ACL_NS}Control`
};
const FULL_AGENT_CLASS = {
  'foaf:Agent': FOAF_AGENT,
  'acl:AuthenticatedAgent': ACL_AUTH_AGENT
};

// --- CRUD tools ---

async function write_resource({ path, content, contentType, types }, ctx) {
  if (!path) return toolError('path required');
  if (path.endsWith('/')) return toolError('cannot PUT a container; use create_resource');
  if (content == null) return toolError('content required');
  if (!(await wac(ctx, path, AccessMode.WRITE))) {
    return toolError(`access denied: write ${path}`);
  }
  const w = await applyLwsWrite({
    storage,
    storagePath: path,
    resourceUrl: buildUrl(ctx, path),
    content: Buffer.from(content, 'utf8'),
    contentType: contentType || 'text/plain',
    declaredTypes: Array.isArray(types) ? types : [],
    lwsEnabled: ctx.lwsEnabled
  });
  if (!w.ok) return w.problem ? toolError(w.problem.detail) : admissionError(path, { violations: w.violations, shapeUrl: w.shapeUrl });
  if (!w.wrote) return toolError(`write failed: ${path}`);
  emitChange(buildUrl(ctx, path));
  return toolText(`wrote ${path} (${Buffer.byteLength(content, 'utf8')} bytes)`);
}

async function create_resource({ container, slug, content, contentType, isContainer, types }, ctx) {
  if (!container || !container.endsWith('/')) {
    return toolError('container path required (must end in /)');
  }
  if (!(await wac(ctx, container, AccessMode.APPEND))) {
    return toolError(`access denied: append ${container}`);
  }
  if (!(await storage.exists(container))) {
    return toolError(`container not found: ${container}`);
  }
  const name = await storage.generateUniqueFilename(container, slug || null, !!isContainer);
  const childPath = `${container}${name}${isContainer ? '/' : ''}`;
  if (isContainer) {
    await storage.createContainer(childPath);
    emitChange(buildUrl(ctx, childPath));
    return toolText(`created container ${childPath}`);
  }
  const w = await applyLwsWrite({
    storage,
    storagePath: childPath,
    resourceUrl: buildUrl(ctx, childPath),
    content: Buffer.from(content || '', 'utf8'),
    contentType: contentType || 'text/plain',
    declaredTypes: Array.isArray(types) ? types : [],
    lwsEnabled: ctx.lwsEnabled
  });
  if (!w.ok) return w.problem ? toolError(w.problem.detail) : admissionError(childPath, { violations: w.violations, shapeUrl: w.shapeUrl });
  if (!w.wrote) return toolError(`write failed: ${childPath}`);
  emitChange(buildUrl(ctx, childPath));
  return toolText(`created ${childPath}`);
}

async function delete_resource({ path }, ctx) {
  if (!path) return toolError('path required');
  if (!(await wac(ctx, path, AccessMode.WRITE))) {
    return toolError(`access denied: delete ${path}`);
  }
  if (!(await storage.exists(path))) {
    return toolError(`not found: ${path}`);
  }
  await storage.remove(path);
  emitChange(buildUrl(ctx, path));
  return toolText(`deleted ${path}`);
}

// --- ACL tools (#496) ---

function aclUrlFor(path) {
  // For containers, ACL is <container>.acl
  // For resources, ACL is <resource>.acl
  if (path.endsWith('/')) return path + '.acl';
  return path + '.acl';
}

function fullMode(mode) {
  return FULL_MODE[mode] || mode;
}

function fullAgentClass(value) {
  return FULL_AGENT_CLASS[value] || value;
}

function buildAclDoc(structured, targetRef, isContainer) {
  const graph = structured.authorizations.map((auth, i) => {
    const node = {
      '@id': `#auth${i}`,
      '@type': 'acl:Authorization',
      // accessTo is a *relative* IRI; the parser resolves it against the
      // ACL's base URL (parser.js getBaseUrl()), which is the parent
      // container directory for BOTH container and resource ACLs. So './'
      // resolves to that container — correct for a container ACL, but for a
      // *resource* ACL it points at the parent container, not the resource,
      // leaving checkAuthorizations() (which requires an exact accessTo
      // match) with zero authorizations and locking out even the owner who
      // just granted themselves Control (#575). targetRef is therefore './'
      // for a container and './<basename>' for a resource. Relative IRIs
      // keep stored ACLs host-portable across origins (#428).
      'acl:accessTo': { '@id': targetRef },
      'acl:mode': (auth.modes || []).map(m => ({ '@id': `acl:${m}` }))
    };
    if (auth.agents && auth.agents.length) {
      node['acl:agent'] = auth.agents.map(a => ({ '@id': a }));
    }
    if (auth.agentClasses && auth.agentClasses.length) {
      node['acl:agentClass'] = auth.agentClasses.map(c => ({
        '@id': fullAgentClass(c)
      }));
    }
    // acl:default only has meaning on a container ACL (it supplies the
    // defaults inherited by contained resources), where targetRef is './'.
    if (auth.isDefault && isContainer) {
      node['acl:default'] = { '@id': targetRef };
    }
    return node;
  });
  return {
    '@context': {
      acl: ACL_NS,
      foaf: 'http://xmlns.com/foaf/0.1/'
    },
    '@graph': graph
  };
}

async function write_acl({ path, authorizations }, ctx) {
  if (!path) return toolError('path required');
  if (!Array.isArray(authorizations)) {
    return toolError('authorizations must be an array');
  }
  // Writing the ACL document requires Control on the resource.
  if (!(await wac(ctx, path, AccessMode.CONTROL))) {
    return toolError(`access denied: control ${path}`);
  }
  const aclPath = aclUrlFor(path);
  const isContainer = path.endsWith('/');
  // Relative target IRI for the stored ACL (host-portable, #428): './' for
  // a container, './<basename>' for a resource. The parser resolves it
  // against the ACL base URL (the parent container directory), so the
  // basename lands on the resource.
  const targetRef = isContainer
    ? './'
    : './' + path.replace(/\/+$/, '').split('/').pop();
  const targetUrl = buildUrl(ctx, path); // absolute, for the lockout check below
  const doc = buildAclDoc({ authorizations }, targetRef, isContainer);
  const serialized = serializeAcl(doc);

  // Safety: refuse to write an ACL that would lock the caller out of
  // future Control. Two footguns are covered:
  //   1. relative WebID paths in `agents` resolving against the .acl URL
  //      to a different absolute URI than the caller's actual WebID;
  //   2. an authorization whose `accessTo` does not actually cover this
  //      resource (e.g. #575), which the checker would skip entirely.
  // Parse the proposed ACL with its real URL so relative refs resolve
  // correctly, then require an authorization that both grants Control to
  // the caller *and* applies to this target.
  const aclAbsUrl = buildUrl(ctx, aclPath);
  const proposed = await parseAcl(serialized, aclAbsUrl);
  const normUrl = u => String(u).replace(/\/$/, '');
  const grantsCallerControl = auth => {
    if (!(auth.modes || []).includes(AccessMode.CONTROL)) return false;
    if (ctx.webId && (auth.agents || []).includes(ctx.webId)) return true;
    if ((auth.agentClasses || []).includes(FOAF_AGENT)) return true;
    if (ctx.webId && (auth.agentClasses || []).includes(ACL_AUTH_AGENT)) return true;
    return false;
  };
  const appliesToTarget = auth => {
    const t = normUrl(targetUrl);
    return (auth.accessTo || []).some(a => normUrl(a) === t) ||
      (auth.default || []).some(d => {
        const p = normUrl(d);
        return t === p || t.startsWith(p + '/');
      });
  };
  // Distinguish the two failure modes so the caller can fix the right thing:
  //   (a) no authorization grants Control to the caller at all, vs
  //   (b) one does, but its accessTo/default does not cover this target.
  const controlAuths = proposed.filter(grantsCallerControl);
  if (controlAuths.length === 0) {
    return toolError(
      `write_acl refused: the proposed ACL would not grant Control to the caller (${ctx.webId || 'anonymous'}). ` +
      'This is typically caused by relative WebID paths in agents resolving against the .acl URL — use absolute WebIDs. ' +
      'If you really want to remove your own access (e.g. transferring ownership), do it in two steps: ' +
      'first grant Control to the new owner, then have the new owner write_acl without you.'
    );
  }
  if (!controlAuths.some(appliesToTarget)) {
    return toolError(
      `write_acl refused: the proposed ACL grants Control to the caller (${ctx.webId || 'anonymous'}) ` +
      `but none of those authorizations apply to ${path} — their accessTo/default targets a different ` +
      'resource (commonly the parent container), so the resource would be left with no effective Control. ' +
      'Ensure each authorization\'s accessTo covers this resource.'
    );
  }

  await storage.write(aclPath, Buffer.from(serialized, 'utf8'), {
    contentType: 'application/ld+json'
  });
  emitChange(buildUrl(ctx, aclPath));
  return toolText(`wrote ${aclPath} (${authorizations.length} authorization${authorizations.length === 1 ? '' : 's'})`);
}

// --- subscribe (#494) ---
//
// `subscribe` is a streaming tool. The handler signals its streaming
// shape by returning { stream: true, init, run }. The MCP plugin
// switches the HTTP response to SSE when it sees this shape and calls
// `init` first (for the initial event) then `run(send, signal)` to push
// notifications until the client disconnects.

function pathMatchesScope(eventUrl, scopePath, origin) {
  if (!eventUrl.startsWith(origin)) return false;
  const eventPath = eventUrl.slice(origin.length);
  if (scopePath === '/') return true;
  if (scopePath.endsWith('/')) return eventPath.startsWith(scopePath);
  return eventPath === scopePath;
}

function subscribe({ path }, ctx) {
  const scope = path || '/';
  return {
    stream: true,
    async init() {
      return {
        type: 'subscribed',
        scope,
        origin: ctx.origin,
        identity: ctx.webId || null
      };
    },
    async run(send, signal) {
      const onChange = async (eventUrl) => {
        if (signal.aborted) return;
        if (!pathMatchesScope(eventUrl, scope, ctx.origin)) return;

        // Per-event WAC filter — don't leak resources the subscriber
        // can't see. The check is best-effort: if the resource was just
        // deleted we may not have storage to read its ACL from, so we
        // err on the side of not emitting.
        const eventPath = eventUrl.slice(ctx.origin.length);
        try {
          const allowed = await wac(ctx, eventPath, AccessMode.READ);
          if (!allowed) return;
        } catch {
          return;
        }
        send({
          type: 'resource_changed',
          path: eventPath,
          url: eventUrl
        });
      };
      resourceEvents.on('change', onChange);
      const cleanup = () => resourceEvents.off('change', onChange);
      signal.addEventListener('abort', cleanup, { once: true });
      // Resolve when aborted — keeps the stream open until client disconnect
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      cleanup();
    }
  };
}

// --- LWS-aware read tools ---
//
// These reuse collectAuthorizedResources — the SAME WAC-filtered walk the
// HTTP /types/* handlers use (src/handlers/type-index.js) — so the no-oracle
// property (a resource the caller can't Read is simply absent from the
// result, never surfaced-then-denied) is inherited, not reimplemented.

async function lws_type_search(args, ctx) {
  let filter;
  try { filter = parseFilter({ body: args || {} }); }
  catch (e) { return toolError(`bad filter: ${e.message}`); }
  const neededRelations = Object.keys(filter.relations);
  const resources = await collectAuthorizedResources({
    agentWebId: ctx.webId, origin: ctx.origin, neededRelations,
  });
  const matched = resources.filter((r) => matchesFilter(r, filter));
  return toolJson({
    type: 'ContainerPage', totalItems: matched.length,
    items: matched.map((r) => ({ id: r.id, type: containerItemTypes(r.types) })),
  });
}

// --- convenience tools ---
//
// Composed from the primitives above — no new server capability, just fewer
// agent round-trips for the common "store a typed thing" / "orient on a
// resource" flows.

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';

// Convenience: the common "store a typed thing" flow in one call. Optionally
// declares a describedby shape into the target .meta (needs Write on .meta)
// BEFORE the governed write, so declare+validate happen together. Still
// LWS-general (no profile assumptions).
async function put_typed_resource({ path, content, contentType, types, describedby }, ctx) {
  if (!path) return toolError('path required');
  if (path.endsWith('/')) return toolError('cannot PUT a container; use create_resource');
  if (content == null) return toolError('content required');
  if (!(await wac(ctx, path, AccessMode.WRITE))) return toolError(`access denied: write ${path}`);

  // Declaring the shape is transactional: snapshot the target .meta, merge the
  // describedby in (so admission validates against it), then roll the .meta
  // back if the write is rejected — a rejected write must leave no durable
  // side effect and must not clobber pre-existing metadata (review #1).
  const metaPath = path + '.meta';
  let metaSnapshot;   // undefined = not touched; null = didn't exist; Buffer = prior bytes
  if (describedby) {
    if (!(await wac(ctx, metaPath, AccessMode.WRITE))) {
      return toolError(`access denied: write ${metaPath} (needed to declare describedby)`);
    }
    metaSnapshot = (await storage.exists(metaPath)) ? await storage.read(metaPath) : null;
    await storage.write(metaPath, Buffer.from(JSON.stringify(mergeDescribedby(metaSnapshot, buildUrl(ctx, path), describedby)), 'utf8'), {
      contentType: 'application/ld+json',
    });
  }

  const w = await applyLwsWrite({
    storage, storagePath: path, resourceUrl: buildUrl(ctx, path),
    content: Buffer.from(content, 'utf8'), contentType: contentType || 'text/plain',
    declaredTypes: Array.isArray(types) ? types : [], lwsEnabled: ctx.lwsEnabled,
  });
  if (!w.ok || !w.wrote) {
    if (metaSnapshot !== undefined) {                       // roll the .meta back
      if (metaSnapshot === null) await storage.remove(metaPath);
      else await storage.write(metaPath, metaSnapshot, { contentType: 'application/ld+json' });
    }
    if (w.problem) return toolError(w.problem.detail);      // gate reject (review #2/#10)
    return w.ok ? toolError(`write failed: ${path}`) : admissionError(path, { violations: w.violations, shapeUrl: w.shapeUrl });
  }
  emitChange(buildUrl(ctx, path));
  return toolText(`wrote ${path} (${Buffer.byteLength(content, 'utf8')} bytes${types?.length ? `, types: ${types.join(', ')}` : ''})`);
}

// Merge a describedby declaration into any existing .meta JSON-LD (preserve
// other keys + @context), rather than overwriting the whole document.
function mergeDescribedby(priorBytes, id, describedby) {
  let base = {};
  if (priorBytes) { try { base = JSON.parse(priorBytes.toString('utf8')) || {}; } catch { base = {}; } }
  const dbCtx = { describedby: { '@id': DESCRIBEDBY, '@type': '@id' } };
  let context;
  if (base['@context'] == null) context = dbCtx;
  else if (Array.isArray(base['@context'])) context = [...base['@context'], dbCtx];
  else if (typeof base['@context'] === 'object') context = { ...base['@context'], ...dbCtx };
  else context = [base['@context'], dbCtx];
  return { ...base, '@context': context, '@id': base['@id'] || id, describedby };
}

// Convenience: one read returning body + linkset + declared types together,
// saving an agent 2-3 round-trips to orient on a resource.
async function describe_resource({ path, uri }, ctx) {
  // uri-or-path: removes the "read by URI, write by path" asymmetry at the
  // orientation tool. Local-only — a remote resource has no local linkset.
  if (!path && uri) {
    if (!isLocalUri(ctx.origin, uri)) {
      return toolError(`describe_resource is local-only; use the read_resource tool for ${uri}`);
    }
    path = uriToPath(ctx.origin, uri);
    if (path === null) return toolError(`bad resource uri: ${uri}`);
  }
  if (!path) return toolError('path or uri required');
  // Same single wording for both branches as resources.js's requireRead/
  // requireExists (probe #7 A8) — the order (WAC before exists) already kept
  // existence non-oracular; unifying the string closes the last thing that
  // could ever hint which branch fired.
  if (!(await wac(ctx, path, AccessMode.READ))) return toolError(`not found or not authorized: ${path}`);
  if (!(await storage.exists(path))) return toolError(`not found or not authorized: ${path}`);
  const isContainer = path.endsWith('/');
  let body = null, truncated = false;
  if (!isContainer) {
    const r = await readBounded(path);              // bounded read, shared limit (#5/#6/#12)
    if (r) {
      truncated = r.truncated;
      // Same trust decision as resources/read and read_resource (dt5): RDF/
      // JSON-LD structure-preserved, opaque/free-text fenced — not an
      // unconditional envelope.
      body = sanitizeForTrust(path, r).text;
    }
  }
  const declared = sanitizeTypes(await readDeclaredTypes(storage, path));
  const shapes = sanitizeTypes(await describedbyTargets(storage, path + '.meta', buildUrl(ctx, path)));
  const conformsTo = sanitizeTypes(await conformsToTargets(storage, path + '.meta', buildUrl(ctx, path)));
  // Authz-filtered alternate representations (altr: model) — same no-oracle
  // read the MCP links carrier uses (read-tools.js localLinks) and the HTTP
  // linkset advertises, so conneg-by-profile is discoverable from inside MCP
  // too (probe #7 A2).
  const representations = await readAuthorizedRepresentations(storage, path + '.meta', buildUrl(ctx, path),
    { origin: ctx.origin, agentWebId: ctx.webId, public: ctx.public });
  const linkset = generateLinkset(buildUrl(ctx, path), {
    parentUrl: buildUrl(ctx, parentPath(path)),
    isContainer, describedByShapes: shapes, declaredTypes: declared, conformsTo,
    representations,
  });
  return toolJson({
    path, isContainer, body, truncated, types: declared, linkset,
    hint: 'representations are negotiable via Accept-Profile: <conformsTo-uri>; alternates are listed as rel=alternate',
  });
}

// --- registry ---

export const TOOLS = {
  write_resource: {
    description: 'Write (PUT) a resource at the given path. Overwrites if exists.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        contentType: { type: 'string', description: 'MIME type (default text/plain)' },
        types: { type: 'array', items: { type: 'string' },
          description: 'Optional server-managed type URIs (LWS rel="type" equivalent).' }
      },
      required: ['path', 'content']
    },
    handler: write_resource
  },
  create_resource: {
    description: 'Create a child resource in a container (LDP POST). Server mints the name unless slug is provided.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Parent container path, must end in /' },
        slug: { type: 'string', description: 'Optional filename hint' },
        content: { type: 'string' },
        contentType: { type: 'string' },
        isContainer: { type: 'boolean', description: 'Create a child container instead of a resource' },
        types: { type: 'array', items: { type: 'string' },
          description: 'Optional server-managed type URIs (LWS rel="type" equivalent).' }
      },
      required: ['container']
    },
    handler: create_resource
  },
  delete_resource: {
    description: 'Delete a resource or empty container.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    handler: delete_resource
  },
  write_acl: {
    description: 'Write a structured ACL for a resource. authorizations: [{ agents?, agentClasses?, modes, isDefault? }]. Requires acl:Control.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        authorizations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agents: { type: 'array', items: { type: 'string' } },
              agentClasses: { type: 'array', items: { type: 'string', enum: ['foaf:Agent', 'acl:AuthenticatedAgent'] } },
              modes: { type: 'array', items: { type: 'string', enum: ['Read', 'Write', 'Append', 'Control'] } },
              isDefault: { type: 'boolean' }
            },
            required: ['modes']
          }
        }
      },
      required: ['path', 'authorizations']
    },
    handler: write_acl
  },
  subscribe: {
    description: 'Subscribe to change events on a resource or container subtree. Returns an SSE stream of MCP notifications as resources change. WAC-filtered per event.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Container path (with trailing /) to watch a subtree, or exact resource path. Default: / (whole pod, filtered by Read access).' }
      }
    },
    handler: subscribe
  },
  lws_type_search: {
    description: 'Search pod resources by LWS type, describedby, and/or conformsTo — WAC-filtered, no-oracle. Empty arguments return the full (WAC-filtered) inventory; filter with type/describedby/conformsTo (repeat to AND, comma to OR).',
    inputSchema: { type: 'object', properties: {
      type: { type: 'array', items: {}, description: 'CNF type filter (see LWS Type Search).' },
      describedby: { type: 'array', items: {}, description: 'CNF describedby (shape) filter.' },
      conformsTo: { type: 'array', items: {}, description: 'CNF conformsTo (profile) filter.' },
    } },
    handler: lws_type_search,
  },
  read_resource: {
    description: 'Read any resource by its real https:// URL — this pod\'s or another pod\'s (federation-gated). Returns the representation (JSON-LD with @context intact where the pod vouches for it) plus a `links` block of its header-borne affordances: up, describedby (SHACL shape), storageDescription locally; json-ld#context / alternate / linkset from a remote\'s Link headers. Follow the typed links and resolve terms via @context.',
    inputSchema: {
      type: 'object',
      properties: { uri: { type: 'string', description: 'Absolute http(s) URL.' } },
      required: ['uri']
    },
    handler: read_resource
  },
  list_resources: {
    description: 'List this pod\'s entry-point resources (storage description, pod-info, skills, LWS @context + vocabulary) and the real-URI resource template. Start here to discover the pod.',
    inputSchema: { type: 'object', properties: {} },
    handler: list_resources
  },
  put_typed_resource: {
    description: 'Store a typed resource in one call: writes the body, captures LWS types (rel="type"), and optionally declares a describedby shape into the target .meta. Routes through SHACL admission.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        contentType: { type: 'string', description: 'MIME type (default text/plain)' },
        types: { type: 'array', items: { type: 'string' }, description: 'Server-managed type URIs (LWS rel="type").' },
        describedby: { type: 'string', description: 'Optional SHACL shape URI to declare into the target .meta (needs Write on .meta).' },
      },
      required: ['path', 'content'],
    },
    handler: put_typed_resource,
  },
  describe_resource: {
    description: "One-shot orientation on a local resource (by path or real URL): its body, declared types, and RFC 9264 linkset together. When both are given, path wins and uri is ignored.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        uri: { type: 'string', description: "Alternative to path: the resource's real https:// URL (local only)." }
      },
      required: [],
    },
    handler: describe_resource,
  },
};

/**
 * Return the list of tools in MCP tools/list shape.
 */
export function listToolsForRpc() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

/**
 * Dispatch a tools/call request.
 */
export async function callTool(name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) {
    return toolError(`unknown tool: ${name}`);
  }
  try {
    return await tool.handler(args || {}, ctx);
  } catch (e) {
    return toolError(`tool ${name} threw: ${e.message}`);
  }
}
