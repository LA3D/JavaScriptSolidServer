// src/mcp/resources.js
// The MCP Resources read surface. Resources are addressed by their REAL
// https:// URLs and dispatch happens on the resource itself: a container path
// reads as the LWS container listing, an .acl/.meta sidecar as its structured
// view, anything else as the (bounded, enveloped) body. Read-only, WAC-checked,
// sanitized (externally-sourced bodies/fields go through sanitize.js before
// leaving this module). Every resolver reuses the same read logic + wac() as
// the HTTP layer, so the no-oracle property is inherited, not reimplemented.
import { uriToPath, isLocalUri } from './uri.js';
import { wac, buildUrl } from './wac.js';
import { ResourceError } from './errors.js';
import { RPC_ERRORS } from './protocol.js';
import { AccessMode, parseAcl } from '../wac/parser.js';
import { sanitizeBody, sanitizeField, sanitizeJsonLeaves } from './sanitize.js';
import { readPodSkill, discoverSkills } from './skills.js';
import * as storage from '../storage/filesystem.js';
import { generateLwsContainer } from '../ldp/container.js';
import { buildStorageDescription } from '../lws/storage-description.js';
import { LWS_CONTEXT_OBJECT, LWS_VOCAB, withInlineContext } from '../lws/context.js';
import { getContentType, isRdfContentType } from '../utils/url.js';
import { readBounded, MAX_BODY_BYTES } from './read.js';

// --- helpers ----------------------------------------------------------------

function jsonContents(uri, obj, mimeType = 'application/json') {
  return { contents: [{ uri, mimeType, text: JSON.stringify(obj, null, 2) }] };
}

// WAC-check BEFORE storage.exists so a denied read is indistinguishable from
// not-found where existence is privileged (spec §4, mirrors the HTTP layer).
async function requireRead(ctx, path, uri) {
  if (!(await wac(ctx, path, AccessMode.READ))) {
    throw new ResourceError(RPC_ERRORS.ACCESS_DENIED, `access denied: read ${uri}`);
  }
}
function requireExists(exists, uri) {
  if (!exists) throw new ResourceError(RPC_ERRORS.ACCESS_DENIED, `not found: ${uri}`);
}

// --- fixed resolvers (real .well-known URLs) ---------------------------------

async function readPodInfo(ctx, uri) {
  const skill = await readPodSkill().catch(() => null);
  const skillVisible = skill && (await wac(ctx, skill.path, AccessMode.READ));
  return jsonContents(uri, {
    pod: ctx.origin,
    server: 'jss',
    protocolVersion: '2025-03-26',
    identity: ctx.webId || null,
    storageRoot: `${ctx.origin}/`,
    storageDescription: `${ctx.origin}/.well-known/lws-storage`,
    context: `${ctx.origin}/.well-known/lws/context`,
    vocabulary: `${ctx.origin}/.well-known/lws/vocab`,
    capabilities: { crud: true, acl: true, skills: true, resources: true, federation: true },
    hint: 'Resources are real https:// URLs returning JSON-LD. Read one, then follow its typed links (rel="up", describedby, and edges in the body) and resolve terms via @context (see `context`/`vocabulary`). Start at `storageDescription`.',
    skill: skillVisible ? { path: skill.path, format: skill.format } : null,
  });
}

async function readSkills(ctx, uri) {
  const idx = await discoverSkills();
  const visible = [];
  for (const s of idx['skill:items']) {
    if (await wac(ctx, s['@id'], AccessMode.READ)) visible.push(s);
  }
  return jsonContents(uri, { ...idx, 'skill:items': visible });
}

async function readStorageDescription(ctx, uri) {
  const sd = buildStorageDescription(ctx.origin, {
    typeIndexEnabled: ctx.typeIndexEnabled, notificationsEnabled: ctx.notificationsEnabled,
  });
  return jsonContents(uri, withInlineContext(sd), 'application/lws+json');
}

async function readLwsContext(_ctx, uri) {
  return jsonContents(uri, { '@context': LWS_CONTEXT_OBJECT }, 'application/ld+json');
}

async function readLwsVocab(_ctx, uri) {
  return jsonContents(uri, LWS_VOCAB, 'application/ld+json');
}

// Fixed resources are origin-relative, so they resolve by path suffix here;
// the advertisement (surface.js listFixed) fills the origin in at list time.
const FIXED_SUFFIX = {
  '/.well-known/lws-storage': readStorageDescription,
  '/.well-known/mcp/pod-info': readPodInfo,
  '/.well-known/mcp/skills': readSkills,
  '/.well-known/lws/context': readLwsContext,
  '/.well-known/lws/vocab': readLwsVocab,
};

// --- per-resource views -------------------------------------------------------

async function readContainerView(path, ctx, uri) {
  await requireRead(ctx, path, uri);
  requireExists(await storage.exists(path), uri);
  const entries = await storage.listContainer(path);
  // Entry names are client-controlled — neutralize hidden chars before they
  // enter the model's context, then build via the shared HTTP builder.
  const clean = (entries || []).map(e => ({ ...e, name: sanitizeField(e.name) }));
  const rep = generateLwsContainer(buildUrl(ctx, path), clean);
  return jsonContents(uri, withInlineContext(rep), 'application/lws+json');
}

async function readAclView(path, ctx, uri) {
  // The URI addresses the ACL document (X.acl); authorization is judged on the
  // TARGET X. A container's own ACL lives INSIDE it (<dir>/.acl), a resource's
  // beside it (<file>.acl) — the same rule as src/wac/checker.js. Detect
  // container-ness from storage (not just a trailing slash) so /dir.acl and
  // /dir/.acl both resolve /dir/.acl, and the Control check runs against the
  // right target (review #3).
  const stripped = path.slice(0, -'.acl'.length);   // '/dir/.acl' -> '/dir/'
  // stat only resolves the WAC target's container-ness (trailing-slash vs not),
  // not an existence answer — the CONTROL check below denies uniformly either
  // way, so probing stat pre-WAC is not a no-oracle violation.
  const s = await storage.stat(stripped);
  const isContainer = stripped.endsWith('/') || !!(s && s.isDirectory);
  const target = isContainer && !stripped.endsWith('/') ? stripped + '/' : stripped;
  // Reading the ACL document itself requires Control on the resource.
  if (!(await wac(ctx, target, AccessMode.CONTROL))) {
    throw new ResourceError(RPC_ERRORS.ACCESS_DENIED, `access denied: control ${uri}`);
  }
  const aclPath = target + '.acl';
  if (!(await storage.exists(aclPath))) {
    return jsonContents(uri, { path: stripped, aclPath, exists: false, authorizations: [] });
  }
  const content = await storage.read(aclPath);
  const auths = await parseAcl(content.toString('utf8'), buildUrl(ctx, aclPath));
  return jsonContents(uri, {
    path: stripped, aclPath, exists: true,
    authorizations: auths.map(a => ({
      agents: (a.agents || []).map(sanitizeField),
      agentClasses: a.agentClasses || [],
      modes: (a.modes || []).map(m => m.split('#').pop()),
      isDefault: !!a.default,
    })),
  });
}

async function readMetaView(path, ctx, uri) {
  const target = path.slice(0, -'.meta'.length);    // '/dir/.meta' -> '/dir/'
  await requireRead(ctx, target, uri);
  requireExists(await storage.exists(target), uri);
  const s = await storage.stat(target);
  return jsonContents(uri, {
    path: target, isContainer: target.endsWith('/'),
    size: s?.size ?? null, modified: s?.mtime ?? null,
  });
}

async function readBody(path, ctx, uri) {
  await requireRead(ctx, path, uri);
  const r = await readBounded(path);
  requireExists(r, uri);
  const type = getContentType(path);
  // Trust rule: the pod's own RDF/JSON-LD is affordance — preserve structure +
  // @context; strip only leaf values. Opaque/free-text is untrusted — envelope.
  // Recognize JSON by content for a truly unknown (extensionless → octet-stream)
  // type too, so an agent's JSON-LD written at a path without a `.jsonld`
  // extension keeps its @context instead of being enveloped. An EXPLICIT
  // text/* type is left as the writer declared it (still enveloped).
  const unknown = type === 'application/octet-stream';
  if ((isRdfContentType(type) || (unknown && /^\s*[{[]/.test(r.text))) && !r.truncated) {
    try {
      const obj = JSON.parse(r.text);
      const safe = withInlineContext(sanitizeJsonLeaves(obj));   // field-level strip, structure kept
      // Keep a declared RDF type; else infer ld+json when an @context is present.
      const mimeType = isRdfContentType(type) ? type
        : (obj && typeof obj === 'object' && obj['@context']) ? 'application/ld+json' : 'application/json';
      return { contents: [{ uri, mimeType, text: JSON.stringify(safe, null, 2) }] };
    } catch { /* not JSON (e.g. Turtle) or malformed — fall through to envelope */ }
  }
  let label = `untrusted pod content — original type ${type}`;
  if (r.truncated) label += ` (truncated: first ${MAX_BODY_BYTES} of ${r.bytes} bytes)`;
  return { contents: [{ uri, mimeType: 'text/plain', text: sanitizeBody(r.text, label) }] };
}

// Dispatch on the resource itself — no synthetic kind. Each view carries its
// own WAC gate (Read for container/meta/body, Control for the ACL document)
// so the no-oracle order (WAC before exists) is preserved per branch.
async function readByResource(path, ctx, uri) {
  if (path.endsWith('/')) return readContainerView(path, ctx, uri);
  if (path.endsWith('.acl')) return readAclView(path, ctx, uri);
  if (path.endsWith('.meta')) return readMetaView(path, ctx, uri);
  return readBody(path, ctx, uri);
}

// --- dispatch ---------------------------------------------------------------

export async function readResource(uri, ctx) {
  // Normalize a trailing-slash origin at the resolver boundary so the
  // `origin + '/'` locality match (uri.js) can't be broken by wiring.
  const origin = typeof ctx?.origin === 'string' ? ctx.origin.replace(/\/+$/, '') : ctx?.origin;
  if (origin !== ctx?.origin) ctx = { ...ctx, origin };
  if (!isLocalUri(ctx.origin, uri)) {
    throw new ResourceError(RPC_ERRORS.INVALID_PARAMS,
      `not a local resource: ${uri}. Use the read_remote_resource tool for another pod.`);
  }
  const path = uriToPath(ctx.origin, uri);
  if (path === null) throw new ResourceError(RPC_ERRORS.INVALID_PARAMS, `bad resource URI: ${uri}`);
  const fixed = FIXED_SUFFIX[path];
  if (fixed) return fixed(ctx, uri);
  return readByResource(path, ctx, uri);
}
