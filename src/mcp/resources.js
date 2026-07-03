// src/mcp/resources.js
// Declarative resource registry for the MCP Resources primitive. Read-only,
// URI-addressed, WAC-checked, sanitized (sanitize wiring in Task 8). Every
// resolver reuses the same read logic + wac() as the former read tools, so
// the no-oracle property is inherited, not reimplemented.
import { parseUri, fixedUri } from './uri.js';
import { wac, buildUrl, parentPath } from './wac.js';
import { ResourceError } from './errors.js';
import { RPC_ERRORS } from './protocol.js';
import { AccessMode, parseAcl } from '../wac/parser.js';
import { readPodSkill } from './skills.js';
import * as storage from '../storage/filesystem.js';
import { generateLinkset } from '../lws/linkset.js';
import { readDeclaredTypes } from '../lws/type-metadata.js';
import { describedbyTargets } from '../lws/constraint.js';

// --- template + fixed advertisement -----------------------------------------

export function listResourceTemplates() {
  return [
    { uriTemplate: 'lws://resource/{+path}', name: 'resource', description: 'A resource body (any content type), enveloped as untrusted data.', mimeType: 'text/plain' },
    { uriTemplate: 'lws://container/{+path}', name: 'container', description: 'A container listing (ldp:contains children).', mimeType: 'application/json' },
    { uriTemplate: 'lws://linkset/{+path}', name: 'linkset', description: 'RFC 9264 linkset: anchor/up/type/describedby.', mimeType: 'application/linkset+json' },
    { uriTemplate: 'lws://meta/{+path}', name: 'meta', description: 'Resource metadata (size/modified).', mimeType: 'application/json' },
    { uriTemplate: 'lws://acl/{+path}', name: 'acl', description: 'Structured ACL (requires acl:Control).', mimeType: 'application/json' },
    { uriTemplate: 'lws://skill/{+path}', name: 'skill', description: 'A skill file body.', mimeType: 'application/json' },
  ];
}

export function listFixedResources() {
  return [
    { uri: 'lws://storage-description', name: 'storage-description', description: 'The LWS storage description (type:Storage + services).', mimeType: 'application/json' },
    { uri: 'lws://pod-info', name: 'pod-info', description: 'Pod identity + MCP capabilities.', mimeType: 'application/json' },
    { uri: 'lws://skills', name: 'skills', description: 'Skill index (WAC-filtered, no-oracle).', mimeType: 'application/json' },
  ];
}

// --- helpers ----------------------------------------------------------------

function jsonContents(uri, obj, mimeType = 'application/json') {
  return { contents: [{ uri, mimeType, text: JSON.stringify(obj, null, 2) }] };
}

// --- fixed resolvers --------------------------------------------------------

async function readPodInfo(ctx) {
  const skill = await readPodSkill().catch(() => null);
  const skillVisible = skill && (await wac(ctx, skill.path, AccessMode.READ));
  return jsonContents(fixedUri('pod-info'), {
    pod: ctx.origin,
    server: 'jss',
    protocolVersion: '2025-03-26',
    identity: ctx.webId || null,
    capabilities: { crud: true, acl: true, skills: true, resources: true },
    skill: skillVisible ? { path: skill.path, format: skill.format } : null,
  });
}

const FIXED = {
  'pod-info': readPodInfo,
  // 'storage-description' and 'skills' added in Task 5.
};

// --- templated resolvers (added in Tasks 4-5) -------------------------------

const MIME = {
  '.json': 'application/json', '.jsonld': 'application/ld+json',
  '.ttl': 'text/turtle', '.md': 'text/markdown', '.html': 'text/html', '.txt': 'text/plain',
};
function mimeFor(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? 'text/plain' : (MIME[path.slice(dot).toLowerCase()] || 'text/plain');
}

// WAC-check BEFORE storage.exists so a denied read is indistinguishable from
// not-found where existence is privileged (spec §4, mirrors lws_linkset).
async function requireRead(ctx, path, uri) {
  if (!(await wac(ctx, path, AccessMode.READ))) {
    throw new ResourceError(RPC_ERRORS.ACCESS_DENIED, `access denied: read ${uri}`);
  }
}
function requireExists(exists, uri) {
  if (!exists) throw new ResourceError(RPC_ERRORS.ACCESS_DENIED, `not found: ${uri}`);
}

async function readResourceBody(path, ctx, uri) {
  await requireRead(ctx, path, uri);
  if (path.endsWith('/')) throw new ResourceError(RPC_ERRORS.INVALID_PARAMS, `use lws://container for containers: ${uri}`);
  requireExists(await storage.exists(path), uri);
  const content = await storage.read(path);
  let text = content.toString('utf8');
  const MAX = 200_000;
  if (text.length > MAX) text = text.slice(0, MAX);
  // Sanitizer envelope wired in Task 8; raw text for now.
  return { contents: [{ uri, mimeType: mimeFor(path), text }] };
}

async function readContainer(path, ctx, uri) {
  const p = path.endsWith('/') ? path : path + '/';
  await requireRead(ctx, p, uri);
  requireExists(await storage.exists(p), uri);
  const entries = await storage.listContainer(p);
  return jsonContents(uri, {
    container: p,
    items: (entries || []).map(e => ({
      name: e.name,
      path: `${p}${e.name}${e.isDirectory ? '/' : ''}`,
      isContainer: e.isDirectory,
      size: e.size ?? null,
      modified: e.modified ?? null,
    })),
  });
}

async function readLinkset(path, ctx, uri) {
  await requireRead(ctx, path, uri);
  requireExists(await storage.exists(path), uri);
  const isContainer = path.endsWith('/');
  const declared = await readDeclaredTypes(storage, path);
  const shapes = await describedbyTargets(storage, path + '.meta', buildUrl(ctx, path));
  const ls = generateLinkset(buildUrl(ctx, path), {
    parentUrl: buildUrl(ctx, parentPath(path)),
    isContainer, describedByShapes: shapes, declaredTypes: declared,
  });
  return jsonContents(uri, ls, 'application/linkset+json');
}

async function readMeta(path, ctx, uri) {
  await requireRead(ctx, path, uri);
  requireExists(await storage.exists(path), uri);
  const s = await storage.stat(path);
  return jsonContents(uri, {
    path, isContainer: path.endsWith('/'),
    size: s?.size ?? null, modified: s?.mtime ?? null,
  });
}

async function readAcl(path, ctx, uri) {
  // Reading the ACL document itself requires Control on the resource.
  if (!(await wac(ctx, path, AccessMode.CONTROL))) {
    throw new ResourceError(RPC_ERRORS.ACCESS_DENIED, `access denied: control ${uri}`);
  }
  const aclPath = path.endsWith('/') ? path + '.acl' : path + '.acl';
  if (!(await storage.exists(aclPath))) {
    return jsonContents(uri, { path, aclPath, exists: false, authorizations: [] });
  }
  const content = await storage.read(aclPath);
  const auths = await parseAcl(content.toString('utf8'), buildUrl(ctx, aclPath));
  return jsonContents(uri, {
    path, aclPath, exists: true,
    authorizations: auths.map(a => ({
      agents: a.agents || [],
      agentClasses: a.agentClasses || [],
      modes: (a.modes || []).map(m => m.split('#').pop()),
      isDefault: !!a.default,
    })),
  });
}

const KIND = {
  resource: readResourceBody,
  container: readContainer,
  linkset: readLinkset,
  meta: readMeta,
  acl: readAcl,
  // 'skill' added in Task 5.
};

// --- dispatch ---------------------------------------------------------------

export async function readResource(uri, ctx) {
  const parsed = parseUri(uri);
  if (!parsed) throw new ResourceError(RPC_ERRORS.INVALID_PARAMS, `unknown resource URI: ${uri}`);
  if (parsed.fixed) {
    const f = FIXED[parsed.fixed];
    if (!f) throw new ResourceError(RPC_ERRORS.INVALID_PARAMS, `unknown resource URI: ${uri}`);
    return f(ctx, uri);
  }
  const resolver = KIND[parsed.kind];
  if (!resolver) throw new ResourceError(RPC_ERRORS.INVALID_PARAMS, `unknown resource URI: ${uri}`);
  return resolver(parsed.path, ctx, uri);
}
