// src/mcp/read-tools.js
// The model-driven read/nav path (spec 2026-07-06-mcp-model-driven-read).
// MCP Resources are application-driven (host-staged) per MCP 2025-03-26, so
// an autonomous agent needs the read loop as Tools: read_resource (one-Web —
// local URIs hit the same resolver as resources/read; any other origin is a
// federation-gated remote read, absorbed verbatim from the retired
// read_remote_resource) and list_resources (the model-callable twin of
// resources/list). `links` carries the affordances HTTP puts in headers —
// MCP results have no header slot, so without it they'd be silently stripped
// (JSON-LD 1.1 syntax §6.1 context link / §6.2 alternate; surfaced, never
// applied — the agent dereferences them itself with read_resource).
import * as storage from '../storage/filesystem.js';
import { AccessMode } from '../wac/parser.js';
import { wac, buildUrl, parentPath } from './wac.js';
import { sanitizeTypes, sanitizeField, sanitizeDeep } from './sanitize.js';
import { describedbyTargets } from '../lws/constraint.js';
import { readAuthorizedRepresentations } from '../lws/representations.js';
import { storageDescriptionUrl } from '../lws/storage-description.js';
import { getContentType } from '../utils/url.js';
import { toolError, toolJson } from './protocol.js';
import { readResource } from './resources.js';
import { ResourceError } from './errors.js';
import { isLocalUri, uriToPath } from './uri.js';
import { listFixed, RESOURCE_TEMPLATE } from './surface.js';

const JSONLD_CONTEXT_REL = 'http://www.w3.org/ns/json-ld#context';

// The JSON-LD-relevant subset of an RFC 8288 Link header, for the remote arm.
// context: json-ld#context (ordinary-JSON upgrade path, JSON-LD 1.1 §6.1);
// alternate: rel="alternate" typed ld+json (§6.2); linkset: RFC 9264. The
// spec allows at most one context link — a malformed multi-link response
// keeps the last one seen. Targets are client-controlled -> sanitizeField.
export function parseRemoteLinks(header) {
  const links = {};
  if (!header || typeof header !== 'string') return links;
  // Split on commas that begin a new <target>; commas inside params survive.
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = part.match(/^\s*<([^>]*)>\s*((?:;[^;]*)*)$/);
    if (!m) continue;
    const params = {};
    for (const p of m[2].split(';')) {
      const kv = p.match(/^\s*([a-zA-Z0-9*_-]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (kv) params[kv[1].toLowerCase()] = kv[2];
    }
    const rels = (params.rel || '').split(/\s+/);
    if (rels.includes(JSONLD_CONTEXT_REL)) links.context = sanitizeField(m[1]);
    else if (rels.includes('alternate') && params.type === 'application/ld+json') links.alternate = sanitizeField(m[1]);
    else if (rels.includes('linkset')) links.linkset = sanitizeField(m[1]);
  }
  return links;
}

// The local read's header-borne affordances, derived from the SAME sources as
// the HTTP Link headers / linkset (constraint store, storage description) —
// one source, no drift. describedby omitted when no shape is declared.
export async function localLinks(path, ctx) {
  const links = { storageDescription: storageDescriptionUrl(buildUrl(ctx, path)) };
  // .well-known/* fixed resources have no meaningful pod-tree parent — an
  // `up` link there would point at the synthetic /.well-known/ "container",
  // which is not a real navigable resource (task-12).
  if (path !== '/' && !path.startsWith('/.well-known/')) links.up = buildUrl(ctx, parentPath(path));
  const shapes = sanitizeTypes(await describedbyTargets(storage, path + '.meta', buildUrl(ctx, path)));
  if (shapes.length) links.describedby = shapes;
  // Alternate representations (altr: model, declared on .meta) — the SAME
  // authz-filtered read the HTTP linkset uses (src/lws/representations.js),
  // so conneg-by-profile is discoverable from inside MCP too (probe #7 A2):
  // an alternate the caller can't Read is simply absent, never
  // surfaced-then-denied (no-oracle). The default/canonical rep is never
  // filtered — the caller is already reading this resource.
  const reps = await readAuthorizedRepresentations(storage, path + '.meta', buildUrl(ctx, path),
    { origin: ctx.origin, agentWebId: ctx.webId, public: ctx.public });
  if (reps.default || reps.alternates.length) {
    Object.assign(links, { canonical: reps.default, alternates: reps.alternates });
  }
  return links;
}

// --- federation constants + gate (moved VERBATIM from tools.js read_remote_resource) ---

// Conservative defaults locked in for v1:
//   1. Federation gate is `<agent-pod>/private/federation/` — caller must
//      have acl:Write there to initiate outbound federation. Foreign WebIDs
//      are denied (no local path to gate against).
//   2. No pod-resident credential storage.
//   3. Depth cap via MCP-Federation-Depth header, max 3.
const MAX_FEDERATION_DEPTH = 3;

function federationGatePathFor(webId, origin) {
  if (!webId || !origin) return null;
  if (!webId.startsWith(origin)) return null;  // foreign WebID — deny
  const localPath = webId.slice(origin.length);
  const profileIdx = localPath.indexOf('/profile/');
  const podPath = profileIdx > 0 ? localPath.slice(0, profileIdx + 1) : '/';
  return podPath + 'private/federation/';
}

async function readRemote(url, ctx) {
  const gatePath = federationGatePathFor(ctx.webId, ctx.origin);
  if (!gatePath) {
    return toolError(
      'access denied: federation requires a local WebID identity (anonymous and foreign identities cannot initiate outbound federation)'
    );
  }
  if (!(await wac(ctx, gatePath, AccessMode.WRITE))) {
    return toolError(
      `access denied: write ${gatePath} (federation gate). Owner must grant acl:Write at this path to delegate outbound federation.`
    );
  }
  const depth = (ctx.federationDepth ?? 0) + 1;
  if (depth > MAX_FEDERATION_DEPTH) {
    return toolError(`federation depth exceeded (max ${MAX_FEDERATION_DEPTH})`);
  }
  let r;
  try {
    r = await fetch(url, {
      headers: {
        Accept: 'application/ld+json, application/lws+json, text/turtle, */*',
        'MCP-Federation-Depth': String(depth)
      },
      signal: AbortSignal.timeout(30_000)
    });
  } catch (e) {
    return toolError(`remote unreachable: ${e.message}`);
  }
  const body = await r.text();
  // Header-borne affordances (json-ld#context / alternate / linkset) are the
  // agent's ONLY channel to how a remote representation should be interpreted
  // — surface them (never auto-fetch/apply). Body: a remote pod is the
  // least-trusted content source — deep-strip (review #7, carried verbatim).
  const links = parseRemoteLinks(r.headers.get('link'));
  return toolJson({
    url,
    status: r.status,
    contentType: r.headers.get('content-type') || null,
    ...(Object.keys(links).length ? { links } : {}),
    body: sanitizeDeep(body)
  });
}

// --- the tools ---

export async function read_resource({ uri }, ctx) {
  if (!uri || typeof uri !== 'string' || !/^https?:\/\//.test(uri)) {
    return toolError('absolute http(s) uri required');
  }
  // Bare-origin normalization now lives in one place: isLocalUri/uriToPath
  // (uri.js) recognize `uri === ctx.origin` as the root container, and the
  // resources.js resolver normalizes it to `origin + '/'` for dispatch —
  // this tool no longer needs its own copy of the patch (task-12 dedup).
  if (!isLocalUri(ctx.origin, uri)) return readRemote(uri, ctx);

  let out;
  try {
    out = await readResource(uri, ctx);              // WAC-before-exists + sanitization inherited
  } catch (e) {
    if (e instanceof ResourceError) return toolError(e.message);  // teaching content, tool-shaped
    throw e;
  }
  const c = out.contents[0];
  const path = uriToPath(ctx.origin, uri);
  const links = await localLinks(path, ctx);
  // The true stored content type (e.g. text/markdown), not c.mimeType — that's
  // the untrusted-content fence's envelope type (text/plain) when the body is
  // fenced; the fence's own "original type" label already carries the real
  // type in prose, this just exposes it structurally too (probe #7 A5).
  return {
    content: [
      { type: 'text', text: c.text },
      { type: 'text', text: JSON.stringify({ uri, mimeType: getContentType(path), links }, null, 2) },
    ],
    isError: false,
  };
}

export async function list_resources(_args, ctx) {
  return toolJson({ resources: listFixed(ctx.origin), templates: [RESOURCE_TEMPLATE] });
}
