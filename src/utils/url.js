import path from 'path';
import * as mime from 'mime-types';

// Base directory for storing all pods
// Use a getter function to read env var at runtime (not import time)
// This is necessary because ES modules are loaded before the CLI sets the env var
export function getDataRoot() {
  return process.env.DATA_ROOT || './data';
}

// Legacy export - kept for compatibility, but callers should use getDataRoot()
export let DATA_ROOT = './data';

// Update DATA_ROOT when env var is set (called from storage init)
export function updateDataRoot() {
  DATA_ROOT = getDataRoot();
}

/**
 * Convert URL path to filesystem path
 * @param {string} urlPath - The URL path (e.g., /alice/profile/)
 * @returns {string} - Filesystem path
 * @throws {Error} - If path traversal is detected
 */
export function urlToPath(urlPath) {
  // Normalize: strip all leading slashes (#131 — `//foo` from bot probes
  // would otherwise leave `/foo`, and path.resolve(root, '/foo') would
  // treat the second arg as absolute, escape dataRoot, and trip the
  // traversal guard with a 500 instead of resolving cleanly to a 404).
  let normalized = urlPath.replace(/^\/+/, '');
  normalized = decodeURIComponent(normalized);

  // Security: remove path traversal attempts (multiple passes for ....// bypass)
  let previous;
  do {
    previous = normalized;
    normalized = normalized.replace(/\.\./g, '');
  } while (normalized !== previous);

  // Resolve to absolute path and verify it's within DATA_ROOT
  const dataRoot = path.resolve(getDataRoot());
  const resolved = path.resolve(dataRoot, normalized);

  // Ensure resolved path is within dataRoot (prevent traversal via path.resolve tricks)
  if (!resolved.startsWith(dataRoot + path.sep) && resolved !== dataRoot) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}

/**
 * Convert URL path to filesystem path in subdomain mode
 * In subdomain mode, the pod is determined by the hostname, not the path
 * @param {string} urlPath - The URL path (e.g., /public/file.txt)
 * @param {string} podName - The pod name from subdomain (e.g., "alice")
 * @returns {string} - Filesystem path (e.g., DATA_ROOT/alice/public/file.txt)
 * @throws {Error} - If path traversal is detected
 */
export function urlToPathWithPod(urlPath, podName) {
  // Normalize: strip all leading slashes (#131 — see urlToPath for context).
  let normalized = urlPath.replace(/^\/+/, '');
  normalized = decodeURIComponent(normalized);

  // Security: remove path traversal attempts (multiple passes for ....// bypass)
  let previous;
  do {
    previous = normalized;
    normalized = normalized.replace(/\.\./g, '');
  } while (normalized !== previous);

  // Also sanitize podName (multiple passes for ....// bypass)
  let safePodName = podName;
  let previousPod;
  do {
    previousPod = safePodName;
    safePodName = safePodName.replace(/\.\./g, '');
  } while (safePodName !== previousPod);

  // Resolve to absolute path and verify it's within DATA_ROOT
  const dataRoot = path.resolve(getDataRoot());
  const resolved = path.resolve(dataRoot, safePodName, normalized);

  // Ensure resolved path is within dataRoot (prevent traversal via path.resolve tricks)
  if (!resolved.startsWith(dataRoot + path.sep) && resolved !== dataRoot) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}

/**
 * Get the effective path for a request (subdomain-aware)
 * @param {object} request - Fastify request object
 * @returns {string} - Filesystem path
 */
export function getPathFromRequest(request) {
  const urlPath = request.url.split('?')[0];

  // In subdomain mode with a recognized pod subdomain
  if (request.subdomainsEnabled && request.podName) {
    return urlToPathWithPod(urlPath, request.podName);
  }

  // Path-based mode (default)
  return urlToPath(urlPath);
}

/**
 * Get the effective URL path for a request (with pod prefix in subdomain mode)
 * @param {object} request - Fastify request object
 * @returns {string} - URL path with pod prefix if needed
 */
export function getEffectiveUrlPath(request) {
  const urlPath = request.url.split('?')[0];

  // In subdomain mode with a recognized pod subdomain, prepend pod name
  if (request.subdomainsEnabled && request.podName) {
    return '/' + request.podName + urlPath;
  }

  return urlPath;
}

/**
 * Check if URL path represents a container (ends with /)
 * @param {string} urlPath
 * @returns {boolean}
 */
export function isContainer(urlPath) {
  return urlPath.endsWith('/');
}

/**
 * Get the parent container path
 * @param {string} urlPath
 * @returns {string}
 */
export function getParentContainer(urlPath) {
  const parts = urlPath.replace(/\/$/, '').split('/');
  parts.pop();
  return parts.join('/') + '/';
}

/**
 * Get the parent container URL from a full resource URL.
 * Returns null when called on the storage root (no parent above the origin).
 * @param {string} url - full URL including scheme (e.g. http://localhost:3000/foo/)
 * @returns {string|null}
 */
export function parentContainerUrl(url) {
  const u = url.endsWith('/') ? url.slice(0, -1) : url;
  const i = u.lastIndexOf('/');
  if (i <= u.indexOf('://') + 2) return null; // at/above origin root
  return u.slice(0, i + 1);
}

/**
 * Get resource name from URL path
 * @param {string} urlPath
 * @returns {string}
 */
export function getResourceName(urlPath) {
  const parts = urlPath.replace(/\/$/, '').split('/');
  return parts[parts.length - 1];
}

/**
 * The sidecar suffixes whose authorization binds to the SUBJECT they describe,
 * not to the sidecar's own path: `.lwstypes`/`.lwsprov` (System-Managed
 * type/provenance) and `.meta` (client-managed governance). `foo.jsonld.meta`
 * describes `foo.jsonld`; a container's bare `/foo/.meta` describes `/foo/`.
 */
export const SIDECAR_SUFFIX = /\.(lwstypes|lwsprov|meta)$/;

/**
 * Resolve the SUBJECT a sidecar path describes, so both surfaces bind the
 * subject's own ACL rather than the container-default the sidecar's own path
 * would walk up to (the "middleware enforces, MCP bypasses" bug class). Shared
 * by the HTTP `authorizeSidecarAccess` (src/auth/middleware.js) and the MCP
 * surface (src/mcp/tools.js write, src/mcp/resources.js read).
 *
 * `X.meta` -> { subject:'X', isContainer:false }; a container's own bare
 * `/foo/.meta` -> { subject:'/foo/', isContainer:true } (trailing slash
 * preserved, so the governance up-walk still binds the container). Returns
 * null when `urlPath` is not a sidecar.
 * @param {string} urlPath
 * @returns {{ subject: string, isContainer: boolean } | null}
 */
export function sidecarSubject(urlPath) {
  const subject = urlPath.replace(SIDECAR_SUFFIX, '');
  if (subject === urlPath) return null;
  return { subject, isContainer: subject.endsWith('/') };
}

/**
 * Every auxiliary sidecar suffix, including `.acl`. Canonical home is here (not
 * storage/filesystem.js) because url.js is the layer that owns path
 * normalization and filesystem.js already imports from here — the reverse
 * import would be circular. `src/storage/filesystem.js` re-exports it as
 * `AUX_SUFFIX` for its existing callers.
 */
export const AUX_SUFFIX_RE = /\.(acl|meta|lwstypes|lwsprov)$/;

/**
 * Case-INSENSITIVE sidecar-suffix matcher, used ONLY by the authorization
 * classifier `auxSubject`. WAC and the storage layer key off the literal
 * lowercase suffix, but a case-insensitive volume aliases `victim.ACL` onto
 * `victim.acl` — so the classifier must recognize any case to bind the CONTROL
 * check (adversarial review 2026-07-22, F1). Kept separate from AUX_SUFFIX_RE so
 * the type-capture / provenance skips in storage/write (which operate on the
 * exact on-disk name) are unchanged.
 */
export const AUX_SUFFIX_CI_RE = /\.(acl|meta|lwstypes|lwsprov)$/i;

/**
 * THE path boundary for the MCP surface. Collapse a client-supplied path to the
 * canonical form that names the SAME filesystem node `urlToPath` will resolve —
 * while staying in URL space, so the result can be handed straight back to
 * `storage.*` (which decodes exactly once) and to WAC without changing meaning.
 *
 * Task 7a round 3 (2026-07-21). Round 2 fixed *sidecar* classification; the
 * non-aux branches still passed the RAW tool argument to `wac()` and the
 * collapsed one to storage. `wac(ctx, '/inbox/victim%2F', WRITE)` asks
 * findApplicableAcl for `/inbox/victim%2F.acl`, finds nothing, walks UP to the
 * container default and GRANTS — then `storage.write` decodes to the real
 * `/inbox/victim`, whose own owner-only `.acl` was never consulted. Same for
 * `victim/`, `victim//`, `victim/.`, `victim/./`, `victim%2F%2E`, on both
 * `write_resource`/`put_typed_resource` and `delete_resource`. HTTP was never
 * vulnerable; this was an MCP-only divergence.
 *
 * Rules, mirroring `urlToPath` exactly:
 *  - `%2F`/`%2E` (either case) become separator/dot — these are the ONLY two
 *    escapes that change path STRUCTURE. Everything else is left encoded, so a
 *    single later `decodeURIComponent` in the storage layer still round-trips
 *    (a blanket decode here would double-decode `%2525` and reintroduce the
 *    very guard/operation divergence this function exists to remove).
 *  - `..` character sequences deleted in a loop (the `....//` bypass).
 *  - empty and `.` segments dropped, repeated separators collapsed.
 *  - a trailing separator is PRESERVED as the container marker; whether it
 *    survives is decided by `resolvePath` in src/mcp/wac.js, which consults
 *    storage — a trailing slash on a path that is a FILE is exactly the
 *    attack, and must not be allowed to reclassify it as a container.
 *
 * `%252F` stays `%252F` here and decodes to a literal `%2F` in a filename —
 * correct, since that is what storage will do too.
 * @param {string} urlPath
 * @returns {string} rooted path, trailing '/' iff the input named a container
 */
export function canonicalPodPath(urlPath) {
  let s = String(urlPath ?? '');
  if (s === '') return '/';
  // Structure-bearing escapes only (see above). Case-insensitive, matching
  // decodeURIComponent.
  s = s.replace(/%2f/gi, '/').replace(/%2e/gi, '.');
  let previous;
  do {
    previous = s;
    s = s.replace(/\.\./g, '');
  } while (s !== previous);
  // Container marker: strip trailing separators and `.` segments, and remember
  // whether anything was there. `a/./` and `a/.` are container-shaped too.
  let t = s;
  do {
    previous = t;
    t = t.replace(/\/+$/, '').replace(/\/\.$/, '');
  } while (t !== previous);
  const hadTrailing = t !== s;
  const segs = s.split('/').filter(seg => seg !== '' && seg !== '.');
  if (segs.length === 0) return '/';
  return '/' + segs.join('/') + (hadTrailing ? '/' : '');
}

/**
 * Normalize a URL path with EXACTLY the rules `urlToPath` applies before the
 * storage layer touches disk, so that a classifier running on the result is
 * looking at the same resource the operation will act on.
 *
 * urlToPath does: decodeURIComponent (once) → delete `..` character sequences
 * (looped, for the `....//` bypass) → path.resolve, which collapses repeated
 * separators, drops `.` segments, and drops trailing slashes. This reproduces
 * all of it in URL space and returns a rooted, slash-normalized path with no
 * trailing slash (`/` for the root).
 *
 * Task 7a round 2 (2026-07-21): this exists because sidecar classification used
 * to run on the RAW MCP tool argument while the operation ran on the normalized
 * one. `$`-anchored suffix tests missed `victim.acl/`, `victim.acl//`,
 * `victim.acl%2F` and `victim.acl/./`, so an Append-only agent could delete a
 * sibling's restrictive `.acl` and then write the unprotected resource. The
 * guard and the operation must never disagree about which path is in play.
 * @param {string} urlPath
 * @returns {string}
 */
export function normalizeAuxPath(urlPath) {
  let s = String(urlPath ?? '');
  // One decode pass, matching urlToPath — `%252F` must stay `%2F`, not become
  // a separator, or the guard would be stricter than the operation.
  try { s = decodeURIComponent(s); } catch { /* malformed escape: classify the raw form */ }
  let previous;
  do {
    previous = s;
    s = s.replace(/\.\./g, '');
  } while (s !== previous);
  const segs = s.split('/').filter(seg => seg !== '' && seg !== '.');
  return '/' + segs.join('/');
}

/**
 * THE sidecar classifier. Normalize first (see `normalizeAuxPath`), then decide
 * whether the path names an auxiliary sidecar and, if so, which SUBJECT its
 * authorization binds to.
 *
 * Shared by all four authorization surfaces so they cannot drift apart again:
 * `applyLwsWrite` (src/lws/write.js — the write choke point) and the MCP
 * `write_resource` / `create_resource` / `delete_resource` tools
 * (src/mcp/tools.js). Each surface keeps its own POLICY (which access mode a
 * given sidecar kind and operation require); only normalize-and-classify is
 * centralized here.
 *
 * `X.acl` -> { subject:'X', isContainer:false }; a container's own bare
 * `/foo/.acl` -> { subject:'/foo/', isContainer:true } (trailing slash
 * preserved, so the governance up-walk still binds the container).
 * Returns null when the normalized path is not a sidecar.
 * @param {string} urlPath
 * @returns {{ path: string, kind: string, subject: string, isContainer: boolean } | null}
 */
export function auxSubject(urlPath) {
  const path = normalizeAuxPath(urlPath);
  // Match case-INSENSITIVELY: WAC and the storage layer look up the literal
  // lowercase `.acl`/`.meta`/..., but on a case-insensitive volume (the macOS
  // `make up` rig bind-mounts ./data) `victim.ACL` is the SAME inode as
  // `victim.acl`. A case-sensitive test would classify `victim.ACL` as a
  // non-sidecar, skip the CONTROL check, and let the write land on the ACL WAC
  // reads — the SEC-1 escalation via case (adversarial review 2026-07-22).
  // Fail-safe on a case-sensitive FS too: an uppercase suffix there is a
  // distinct file, but classifying-and-authorizing it never under-protects.
  const m = path.match(AUX_SUFFIX_CI_RE);
  if (!m) return null;
  const subject = path.replace(AUX_SUFFIX_CI_RE, '');
  // `/foo/.acl` -> `/foo/`: the replace leaves the separator, which is exactly
  // the container marker the WAC up-walk needs. `/.acl` at the storage root
  // leaves '/', already correct. kind is normalized to lowercase so every
  // policy site (`sc.kind === 'meta'`) matches regardless of the input case.
  return { path, kind: m[1].toLowerCase(), subject, isContainer: subject.endsWith('/') };
}

/**
 * Extract pod name from URL path or request
 *
 * Resolves to one of four shapes, by deployment mode:
 *
 * - Subdomain mode with a recognized subdomain → `request.podName` (from hostname).
 * - Subdomain mode with no recognized subdomain → `null` (base-domain access;
 *   callers guard with `if (podName)` and skip pod-scoped side effects).
 * - Single-user, root-pod (`singleUserName` empty or '/') → `'.'` so
 *   `path.join(dataRoot, '.', QUOTA_FILE)` collapses to `<dataRoot>/QUOTA_FILE`.
 * - Single-user, named pod → `singleUserName` (all requests share the one pod,
 *   independent of URL — avoids mistaking a URL segment like `index.html`
 *   for a pod name).
 * - Path-based multi-pod (default, no flags) → first URL segment, or `null`
 *   for requests at `/` that aren't inside any pod.
 *
 * Background: before this function knew about single-user mode, a
 * `PUT /index.html` on a single-user root-pod deployment produced a pod name
 * of `"index.html"`, and the quota sidecar landed at
 * `<dataRoot>/index.html/.quota.json` → `ENOTDIR` (index.html is a file).
 *
 * @param {string|object} pathOrRequest - URL path string or Fastify request object
 * @returns {string|null} - Pod name, `'.'` for root-pod, or `null` when no pod applies
 */
export function getPodName(pathOrRequest) {
  if (typeof pathOrRequest === 'object' && pathOrRequest !== null) {
    // Subdomain mode: hostname drives it. Unrecognized host → no pod.
    if (pathOrRequest.subdomainsEnabled) {
      return pathOrRequest.podName || null;
    }
    // Single-user mode: always the one pod, regardless of URL path.
    if (pathOrRequest.singleUser) {
      const name = pathOrRequest.singleUserName;
      return (!name || name === '/') ? '.' : name;
    }
    // Path-based multi-pod: first URL segment.
    const urlPath = pathOrRequest.url?.split('?')[0] || '';
    return getPodNameFromPath(urlPath);
  }

  // String form: path-based pod extraction.
  return getPodNameFromPath(pathOrRequest);
}

/**
 * Extract pod name from URL path
 * @param {string} urlPath - URL path (e.g., /alice/public/file.txt)
 * @returns {string|null} - Pod name or null
 */
function getPodNameFromPath(urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  // First segment is the pod name (skip system paths)
  const firstPart = parts[0];
  if (firstPart.startsWith('.')) return null; // .well-known, .acl, etc.

  return firstPart;
}

/**
 * Determine content type from file extension
 * @param {string} filePath
 * @returns {string}
 */
export function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  // Solid-specific overrides — types the `mime-types` db doesn't know, or
  // where Solid semantics differ. Checked before falling back to mime-types
  // (which covers the long tail: audio/video/fonts/archives/office/etc.).
  const overrides = {
    '.jsonld': 'application/ld+json',
    '.ttl': 'text/turtle',
    '.n3': 'text/n3',
    '.nt': 'application/n-triples',
    '.rdf': 'application/rdf+xml',
    '.nq': 'application/n-quads',
    '.trig': 'application/trig',
    '.m3u': 'audio/mpegurl',
    '.pls': 'audio/x-scpls',
    // Solid ACL/meta as extensions (e.g. publicTypeIndex.jsonld.acl)
    '.acl': 'application/ld+json',
    '.meta': 'application/ld+json',
    // LWS types sidecar (spec 2026-07-10 §4)
    '.lwstypes': 'application/json',
    // LWS earned-conformsTo provenance sidecar (Task 2, 2026-07-13) — same
    // stance as .lwstypes: plain JSON, no @context, so not ld+json.
    '.lwsprov': 'application/json'
  };

  // Solid convention dotfiles (.acl, .meta) are RDF resources. path.extname
  // returns '' for leading-dot names, so the map lookup above misses them;
  // fall back to a basename check and tag them as JSON-LD — the format JSS
  // writes them in via serializeAcl() / createPodStructure(). Content
  // negotiation then handles Turtle-native clients (umai, Soukai-based apps,
  // older Solid tooling) via handleGet's conneg branch.
  const base = path.basename(filePath);
  if (base === '.acl' || base === '.meta') return 'application/ld+json';
  if (base === '.lwstypes' || base === '.lwsprov') return 'application/json';

  // Overrides first, then the comprehensive mime-types database (as CSS and
  // NSS do), then octet-stream. This is what makes audio/video/etc. resolve
  // to a real type instead of forcing a download. See #533.
  return overrides[ext] || mime.lookup(filePath) || 'application/octet-stream';
}

/**
 * Check if content type is RDF (legacy, `--lws`-off predicate — includes
 * plain `application/json`). The `--lws` serving arm uses the narrower
 * `isRdfSourceType` (`src/rdf/serve.js`) instead: plain JSON is not an RDF
 * source there (probe-#6 — it parsed as JSON-LD to zero quads).
 * @param {string} contentType
 * @returns {boolean}
 */
export function isRdfContentType(contentType) {
  const rdfTypes = [
    'application/ld+json',
    'application/json',
    'text/turtle',
    'text/n3',
    'application/n-triples',
    'application/rdf+xml',
    'application/n-quads',
    'application/trig'
  ];
  return rdfTypes.includes(contentType);
}

/**
 * P2 (Solid #server-content-type-missing MUST): a request that carries a
 * body must carry Content-Type. Fastify's wildcard content-type parser
 * (server.js addContentTypeParser('*')) happily buffers a body under a
 * missing/empty Content-Type — nothing upstream 400s this, so the write
 * handlers (PUT/POST/PATCH) must guard it themselves. Content-Length is
 * the ground truth for "carries a body" (set by the client on the wire);
 * request.body is a fallback for transports that omit it.
 * @param {import('fastify').FastifyRequest} request
 * @returns {boolean}
 */
export function isBodiedWithoutContentType(request) {
  const ct = (request.headers['content-type'] || '').trim();
  if (ct) return false;
  const len = request.headers['content-length'];
  if (len !== undefined) return parseInt(len, 10) > 0;
  const body = request.body;
  if (Buffer.isBuffer(body)) return body.length > 0;
  if (typeof body === 'string') return body.length > 0;
  if (body && typeof body === 'object') return Object.keys(body).length > 0;
  return false;
}

/**
 * Build the P2 400 problem+json body. Callers gate the call on
 * request.lwsEnabled and isBodiedWithoutContentType(request).
 * @param {string} instance - resourceUrl
 * @returns {object}
 */
export function missingContentTypeProblem(instance) {
  return {
    type: 'about:blank', title: 'Bad Request', status: 400,
    detail: 'a request with content must carry Content-Type (Solid #server-content-type-missing)',
    instance,
  };
}

// Security: Maximum JSON size for parsing (10MB)
const MAX_JSON_SIZE = 10 * 1024 * 1024;

/**
 * Safely parse JSON with size limit to prevent DoS
 * @param {string} jsonString - The JSON string to parse
 * @param {number} maxSize - Maximum allowed size (default 10MB)
 * @returns {object} - Parsed JSON object
 * @throws {Error} - If JSON is too large or invalid
 */
export function safeJsonParse(jsonString, maxSize = MAX_JSON_SIZE) {
  if (jsonString.length > maxSize) {
    throw new Error(`JSON exceeds maximum size of ${maxSize} bytes`);
  }
  return JSON.parse(jsonString);
}
