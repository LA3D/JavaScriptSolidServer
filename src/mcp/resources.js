// src/mcp/resources.js
// The MCP Resources read surface. Resources are addressed by their REAL
// https:// URLs and dispatch happens on the resource itself: a container path
// reads as the LWS container listing, an .acl/.meta sidecar as its structured
// view, anything else as the (bounded, enveloped) body. Read-only, WAC-checked,
// sanitized (externally-sourced bodies/fields go through sanitize.js before
// leaving this module). Every resolver reuses the same read logic + wac() as
// the HTTP layer, so the no-oracle property is inherited, not reimplemented.
import { uriToPath, isLocalUri } from './uri.js';
import { sidecarSubject } from '../utils/url.js';
import { wac, buildUrl } from './wac.js';
import { ResourceError } from './errors.js';
import { RPC_ERRORS } from './protocol.js';
import { AccessMode, parseAcl } from '../wac/parser.js';
import { sanitizeField } from './sanitize.js';
import { readPodSkill, discoverSkills } from './skills.js';
import * as storage from '../storage/filesystem.js';
import { generateLwsContainer } from '../ldp/container.js';
import { filterReadableEntries } from '../lws/authorized-listing.js';
import { buildStorageDescription } from '../lws/storage-description.js';
import { LWS_CONTEXT_OBJECT, LWS_VOCAB, withInlineContext } from '../lws/context.js';
import { readBounded, sanitizeForTrust } from './read.js';

// --- helpers ----------------------------------------------------------------

function jsonContents(uri, obj, mimeType = 'application/json') {
  return { contents: [{ uri, mimeType, text: JSON.stringify(obj, null, 2) }] };
}

// WAC-check BEFORE storage.exists so a denied read is indistinguishable from
// not-found where existence is privileged (spec §4, mirrors the HTTP layer).
// Both branches throw the SAME wording (probe #7 A8) — not just the same
// order — so the response text itself can never hint which branch fired.
async function requireRead(ctx, path, uri) {
  if (!(await wac(ctx, path, AccessMode.READ))) {
    throw new ResourceError(RPC_ERRORS.ACCESS_DENIED, `not found or not authorized: ${uri}`);
  }
}
function requireExists(exists, uri) {
  if (!exists) throw new ResourceError(RPC_ERRORS.ACCESS_DENIED, `not found or not authorized: ${uri}`);
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
    hint: 'Resources are real https:// URLs returning JSON-LD. Read one with the read_resource tool, then follow its typed links (up, describedby, and edges in the body) and resolve terms via @context (see `context`/`vocabulary`). Start at `storageDescription`. This substrate speaks RFC 9264 linksets — get a resource\'s typed links via describe_resource, or negotiate application/linkset+json on its URL.',
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
    profileIndexPath: ctx.profileIndexPath, voidPath: ctx.voidPath,
    profileConnegEnabled: ctx.profileConnegEnabled,
    referentResolutionEnabled: ctx.referentResolutionEnabled,
    uriSpacePrefixes: ctx.uriSpacePrefixes,
    mcpEnabled: true,
    anonRateLimitMax: ctx.anonRateLimitMax,
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
  const raw = await storage.listContainer(path);
  // S1 parity (task-12): WAC-filter the membership per requester — same
  // choke point the HTTP listing path uses (src/lws/authorized-listing.js).
  // Unconditional, unlike the HTTP call site's `lwsEnabled && !public` gate:
  // MCP's own wac() (src/mcp/wac.js) has no --lws/--public bypass — every
  // MCP read already enforces real WAC regardless of those flags — and this
  // view always renders the lws+json items[] shape, so neither of the HTTP
  // site's two exceptions ("--public has no WAC to filter by", "--lws off
  // keeps the upstream unfiltered listing") has an analogue here.
  const entries = await filterReadableEntries({
    entries: raw || [], containerUrl: buildUrl(ctx, path), containerStoragePath: path,
    agentWebId: ctx.webId ?? null,
  });
  // Entry names are client-controlled — neutralize hidden chars before they
  // enter the model's context, then build via the shared HTTP builder.
  const clean = entries.map(e => ({ ...e, name: sanitizeField(e.name) }));
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
  // Trust decision (RDF-preserve-vs-fence) lives in sanitizeForTrust
  // (read.js) — the single choke point read_resource and describe_resource
  // share too, so they can't drift on which resources get fenced (dt5).
  const { mimeType, text } = sanitizeForTrust(path, r);
  return { contents: [{ uri, mimeType, text }] };
}

// I2 (sidecar-authz parity, 2026-07-14): `.lwstypes`/`.lwsprov` leak the
// SUBJECT's rdf:type / earned profile, so reading one requires acl:Read on the
// STRIPPED SUBJECT — not the sidecar's own path, which requireRead (via
// findApplicableAcl) walks UP to the container default, never the subject's
// own (possibly tighter) `.acl`. This is the MCP twin of the HTTP C1 fix
// (authorizeSidecarAccess); without it these sidecars fell through to
// readBody, leaking a private member's type/provenance to a container-read
// agent. The sidecar's own bytes are still returned (bounded/fenced, same as
// readBody) — only the AUTHZ target changes. `.meta` is handled by
// readMetaView above (already subject-stripped); this covers its two siblings.
async function readSidecarView(path, ctx, uri) {
  const { subject } = sidecarSubject(path);
  await requireRead(ctx, subject, uri);
  const r = await readBounded(path);
  requireExists(r, uri);
  const { mimeType, text } = sanitizeForTrust(path, r);
  return { contents: [{ uri, mimeType, text }] };
}

// Dispatch on the resource itself — no synthetic kind. Each view carries its
// own WAC gate (Read for container/meta/body, Read-on-subject for the
// type/provenance sidecars, Control for the ACL document) so the no-oracle
// order (WAC before exists) is preserved per branch.
async function readByResource(path, ctx, uri) {
  if (path.endsWith('/')) return readContainerView(path, ctx, uri);
  if (path.endsWith('.acl')) return readAclView(path, ctx, uri);
  if (path.endsWith('.meta')) return readMetaView(path, ctx, uri);
  if (ctx.lwsEnabled && /\.(lwstypes|lwsprov)$/.test(path)) return readSidecarView(path, ctx, uri);
  return readBody(path, ctx, uri);
}

// --- dispatch ---------------------------------------------------------------

export async function readResource(uri, ctx) {
  // Normalize a trailing-slash origin at the resolver boundary so the
  // `origin + '/'` locality match (uri.js) can't be broken by wiring.
  const origin = typeof ctx?.origin === 'string' ? ctx.origin.replace(/\/+$/, '') : ctx?.origin;
  if (origin !== ctx?.origin) ctx = { ...ctx, origin };
  // Bare origin (no trailing slash) = the root container. The ONE
  // normalization point (task-12): the read_resource tool used to duplicate
  // this check before delegating here (src/mcp/read-tools.js) — deleted, so
  // resources/read and the tool both funnel through this single spot.
  if (uri === origin) uri = origin + '/';
  if (!isLocalUri(ctx.origin, uri)) {
    throw new ResourceError(RPC_ERRORS.INVALID_PARAMS,
      `not a local resource: ${uri}. Use the read_resource tool for another pod.`);
  }
  const path = uriToPath(ctx.origin, uri);
  if (path === null) throw new ResourceError(RPC_ERRORS.INVALID_PARAMS, `bad resource URI: ${uri}`);
  const fixed = FIXED_SUFFIX[path];
  if (fixed) return fixed(ctx, uri);
  return readByResource(path, ctx, uri);
}
