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
import { wac, buildUrl, parentPath, resolvePath } from './wac.js';
import { sanitizeTypes, sanitizeField, sanitizeDeep, sanitizeReps } from './sanitize.js';
import { describedbyTargets } from '../lws/constraint.js';
import { readAuthorizedRepresentations } from '../lws/representations.js';
import { storageDescriptionUrl } from '../lws/storage-description.js';
import { storageRootFor } from '../lws/storage-resolver.js';
import { getContentType } from '../utils/url.js';
import { toolError, toolJson } from './protocol.js';
import { readResource } from './resources.js';
import { ResourceError } from './errors.js';
import { isLocalUri, uriToPath } from './uri.js';
import { listFixed, RESOURCE_TEMPLATE } from './surface.js';
import { isBlockedHost, resolvesToBlockedHost } from './ssrf.js';
import { MAX_BODY_BYTES } from './read.js';

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
//
// Multi-tenant round (Task A7): storageDescription must point at the OWNING
// storage (mirrors src/handlers/resource.js's getAllHeaders(storageRootPath)
// threading from A5/c5e4fda) — storageRootFor resolves the resource's root
// (null for server scope / .well-known/*, preserving the origin well-known
// target there), same marker check the HTTP layer uses.
export async function localLinks(path, ctx) {
  const url = buildUrl(ctx, path);
  const root = await storageRootFor(storage, new URL(url).pathname);
  const links = { storageDescription: storageDescriptionUrl(url, root) };
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
  // href/format/profile are client-controlled (declared on .meta) — strip
  // hidden chars before they reach the model (review #3).
  const reps = sanitizeReps(await readAuthorizedRepresentations(storage, path + '.meta', buildUrl(ctx, path),
    { origin: ctx.origin, agentWebId: ctx.webId, public: ctx.public }));
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
  // SSRF guard (dt8, spec §6): a federation-gated agent can otherwise reach
  // LAN/loopback/cloud-metadata endpoints from inside the pod's trust
  // boundary. Default-blocked; --lws-federation-private is the local rig's
  // opt-in. Checked before EVERY hop below — never dial a blocked host at
  // all. Malformed url -> teaching error, not an uncaught throw (dt8 fix
  // round 1).
  let target;
  try {
    target = new URL(url);
  } catch {
    return toolError(`invalid remote URL: ${url}`);
  }
  // Manual redirect loop (review #8): `redirect:'error'` (dt8 fix round 1,
  // CRITICAL 1) dead-ended the pod's own cross-pod rails (e.g. the
  // /.well-known/void 303) along with any legitimate redirect. Following
  // redirects OURSELVES — re-running the SSRF guard on every hop, not just
  // the initial URL — restores those rails while still closing CRITICAL 1
  // (a public host 302-ing to cloud metadata is caught on the redirect hop,
  // never blindly dialed the way undici's default redirect:'follow' would).
  const MAX_REDIRECT_HOPS = 3;
  let r;
  for (let hop = 0; ; hop++) {
    if (isBlockedHost(target.hostname, { allowPrivate: ctx.federationPrivate })) {
      return toolError(
        `federation blocked: ${target.href} resolves to a private/internal address (set --lws-federation-private to allow)`
      );
    }
    // DNS pre-check (dt8 cluster 3): isBlockedHost above only catches the
    // LITERAL hostname/IP — a public-looking NAME that resolves to a private
    // address slips past it. resolvesToBlockedHost resolves A/AAAA and closes
    // that gap per hop, re-entering on every redirect just like the literal
    // check above.
    if (await resolvesToBlockedHost(target.hostname, { allowPrivate: ctx.federationPrivate })) {
      return toolError(
        `federation blocked: ${target.href} resolves to a private/internal address (set --lws-federation-private to allow)`
      );
    }
    try {
      r = await fetch(target.href, {
        headers: {
          Accept: 'application/ld+json, application/lws+json, text/turtle, */*',
          'MCP-Federation-Depth': String(depth)
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000)
      });
    } catch (e) {
      return toolError(`remote unreachable: ${e.message}`);
    }
    const loc = r.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(r.status) || !loc) break;
    if (hop >= MAX_REDIRECT_HOPS - 1) {
      return toolError(`too many redirects (max ${MAX_REDIRECT_HOPS}): ${url}`);
    }
    try {
      target = new URL(loc, target);
    } catch {
      return toolError(`invalid redirect target from ${target.href}: ${loc}`);
    }
  }
  // Bounded body read — a remote pod is the LEAST-trusted content source
  // (unlike local reads, already capped by readBounded/MAX_BODY_BYTES),
  // so never buffer an unbounded body from it (dt8, spec §6).
  const { text: body, truncated } = await readRemoteBody(r);
  // Header-borne affordances (json-ld#context / alternate / linkset) are the
  // agent's ONLY channel to how a remote representation should be interpreted
  // — surface them (never auto-fetch/apply). Body: a remote pod is the
  // least-trusted content source — deep-strip (review #7, carried verbatim).
  const links = parseRemoteLinks(r.headers.get('link'));
  return toolJson({
    url: target.href,
    // The FINAL hop's URL is what was actually read; resolvedFrom names the
    // caller's original URL when a redirect moved it, so the agent sees
    // where a rail (e.g. /.well-known/void's 303) actually landed (#8).
    ...(target.href !== url ? { resolvedFrom: url } : {}),
    status: r.status,
    contentType: r.headers.get('content-type') || null,
    ...(Object.keys(links).length ? { links } : {}),
    ...(truncated ? { truncated: true } : {}),
    body: sanitizeDeep(body)
  });
}

// Reads at most `max` bytes off the response stream and cancels the rest,
// rather than `await r.text()`-ing an attacker-controlled body fully into
// memory first. Mirrors readBounded's (src/mcp/read.js) truncated-flag
// shape; falls back to a capped r.text() when the runtime hands back a
// response with no readable stream (e.g. a test double).
async function readRemoteBody(r, max = MAX_BODY_BYTES) {
  const reader = r.body?.getReader?.();
  if (!reader) {
    const text = await r.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= max) return { text, truncated: false };
    return { text: Buffer.from(text, 'utf8').subarray(0, max).toString('utf8'), truncated: true };
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      truncated = true;
      chunks.push(value.subarray(0, value.byteLength - (total - max)));
      try { await reader.cancel(); } catch { /* noop */ }
      break;
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
  return { text, truncated };
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
  // Task 7a round 3: the body above came from readResource, which normalizes at
  // its own boundary — derive the links block from the SAME normalized path, so
  // `localLinks`/`getContentType` describe the resource that was actually read
  // rather than an alias of it.
  const path = await resolvePath(uriToPath(ctx.origin, uri));
  const links = await localLinks(path, ctx);
  // The true stored content type (e.g. text/markdown), not c.mimeType — that's
  // the untrusted-content fence's envelope type (text/plain) when the body is
  // fenced; the fence's own "original type" label already carries the real
  // type in prose, this just exposes it structurally too (probe #7 A5).
  // #13: extension-derived only when the extension actually resolves —
  // containers, /.well-known/*, and extensionless resources report the
  // trust/view type (c.mimeType), agreeing with the resources/read primitive.
  const extType = getContentType(path);
  const mimeType = extType !== 'application/octet-stream' ? extType : c.mimeType;
  return {
    content: [
      { type: 'text', text: c.text },
      { type: 'text', text: JSON.stringify({ uri, mimeType, links }, null, 2) },
    ],
    isError: false,
  };
}

export async function list_resources(_args, ctx) {
  return toolJson({ resources: listFixed(ctx.origin), templates: [RESOURCE_TEMPLATE] });
}
