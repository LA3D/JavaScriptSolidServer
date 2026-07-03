// src/mcp/resources.js
// Declarative resource registry for the MCP Resources primitive. Read-only,
// URI-addressed, WAC-checked, sanitized (externally-sourced bodies/fields go
// through sanitize.js before leaving this module). Every resolver reuses the
// same read logic + wac() as the former read tools, so the no-oracle
// property is inherited, not reimplemented.
import { parseUri, fixedUri } from './uri.js';
import { SURFACE_TEMPLATES, SURFACE_FIXED } from './surface.js';
import { wac, buildUrl, parentPath } from './wac.js';
import { ResourceError } from './errors.js';
import { RPC_ERRORS } from './protocol.js';
import { AccessMode, parseAcl } from '../wac/parser.js';
import { sanitizeBody, sanitizeField } from './sanitize.js';
import { readPodSkill, readSkill, discoverSkills } from './skills.js';
import * as storage from '../storage/filesystem.js';
import { generateLinkset } from '../lws/linkset.js';
import { readDeclaredTypes } from '../lws/type-metadata.js';
import { describedbyTargets } from '../lws/constraint.js';
import { buildStorageDescription } from '../lws/storage-description.js';

// --- template + fixed advertisement (derived from the surface registry) ------

export function listResourceTemplates() {
  return SURFACE_TEMPLATES.map(t => ({
    uriTemplate: `lws://${t.kind}/{+path}`, name: t.kind,
    description: t.description, mimeType: t.mimeType,
  }));
}

export function listFixedResources() {
  return SURFACE_FIXED.map(f => ({
    uri: `lws://${f.name}`, name: f.name,
    description: f.description, mimeType: f.mimeType,
  }));
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

async function readSkills(ctx, uri) {
  const idx = await discoverSkills();
  const visible = [];
  for (const s of idx['skill:items']) {
    if (await wac(ctx, s['@id'], AccessMode.READ)) visible.push(s);
  }
  return jsonContents(uri, { ...idx, 'skill:items': visible });
}

async function readStorageDescription(ctx, uri) {
  return jsonContents(uri, buildStorageDescription(ctx.origin, {
    typeIndexEnabled: ctx.typeIndexEnabled, notificationsEnabled: ctx.notificationsEnabled,
  }));
}

const FIXED = {
  'pod-info': readPodInfo,
  'skills': readSkills,
  'storage-description': readStorageDescription,
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
  return { contents: [{ uri, mimeType: 'text/plain', text: sanitizeBody(text, `untrusted pod content — original type ${mimeFor(path)}`) }] };
}

async function readContainer(path, ctx, uri) {
  const p = path.endsWith('/') ? path : path + '/';
  await requireRead(ctx, p, uri);
  requireExists(await storage.exists(p), uri);
  const entries = await storage.listContainer(p);
  return jsonContents(uri, {
    container: p,
    items: (entries || []).map(e => ({
      name: sanitizeField(e.name),
      path: `${p}${sanitizeField(e.name)}${e.isDirectory ? '/' : ''}`,
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
      agents: (a.agents || []).map(sanitizeField),
      agentClasses: a.agentClasses || [],
      modes: (a.modes || []).map(m => m.split('#').pop()),
      isDefault: !!a.default,
    })),
  });
}

async function readSkillResource(path, ctx, uri) {
  await requireRead(ctx, path, uri);
  let skill;
  try { skill = await readSkill(path); }
  catch (e) { throw new ResourceError(RPC_ERRORS.ACCESS_DENIED, `not found: ${uri}`); }
  return jsonContents(uri, { ...skill, body: sanitizeBody(skill.body, 'untrusted skill content') });
}

const KIND = {
  resource: readResourceBody,
  container: readContainer,
  linkset: readLinkset,
  meta: readMeta,
  acl: readAcl,
  skill: readSkillResource,
};

// Exposed so a guard test can assert the resolver maps cover exactly the
// surface registry (no advertise-without-resolver / resolver-without-parse
// drift — review #11). The dispatch below reads from these same maps.
export const RESOLVERS = { KIND, FIXED };

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
