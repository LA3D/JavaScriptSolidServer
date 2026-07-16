import crypto from 'crypto';
import * as storage from '../storage/filesystem.js';
import { checkQuota, updateQuotaUsage } from '../storage/quota.js';
import { getAllHeaders, getNotFoundHeaders, representationLinks } from '../ldp/headers.js';
import { generateContainerJsonLd, generateLwsContainer, serializeJsonLd } from '../ldp/container.js';
import { generateLinkset } from '../lws/linkset.js';
import { describedbyTargets, conformsToTargets } from '../lws/constraint.js';
import { isContainer, getContentType, isRdfContentType, getEffectiveUrlPath, safeJsonParse, getPodName, parentContainerUrl, isBodiedWithoutContentType, missingContentTypeProblem } from '../utils/url.js';
import { parseN3Patch, applyN3Patch, validatePatch } from '../patch/n3-patch.js';
import { parseSparqlUpdate, applySparqlUpdate } from '../patch/sparql-update.js';
import { applyMergePatch } from '../patch/merge-patch.js';
import { applyPatchToDataset, patchDeletesExist, resolveWhere } from '../patch/dataset-patch.js';
import { toDataset } from '../rdf/dataset.js';
import {
  selectContentType,
  canAcceptInput,
  toJsonLd,
  fromJsonLd,
  RDF_TYPES,
  getVaryHeader,
  negotiateProfile,
  acceptSatisfiable,
  acceptsHtml,
  prefersPlainJson
} from '../rdf/conneg.js';
import { readAuthorizedRepresentations } from '../lws/representations.js';
import { getWebIdFromRequestAsync } from '../auth/token.js';
import { resolveReferent } from '../lws/referent-resolver.js';
import { storageRootFor } from '../lws/storage-resolver.js';
import { checkAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';
import { emitChange } from '../notifications/events.js';
import { checkIfMatch, checkIfNoneMatchForGet, checkIfNoneMatchForWrite } from '../utils/conditional.js';
import { generateDatabrowserHtml, generateModuleDatabrowserHtml, shouldServeMashlib, browserWantsHtml, DATA_ISLAND_MAX_BYTES } from '../mashlib/index.js';
import { turtleToJsonLd } from '../rdf/turtle.js';
import { constraintProblem, urlToStoragePath } from '../lws/admission.js';
import { parseTypeLinks, typeStorePath, readDeclaredTypes, readProvenance } from '../lws/type-metadata.js';
import { applyLwsWrite } from '../lws/write.js';
import { filterReadableEntries } from '../lws/authorized-listing.js';
import { serveStoredRdf, checkServable, isRdfSourceType, QUADS_OUTPUTS, nonRdfNotAcceptable, datasetToFormat } from '../rdf/serve.js';
import { renderContainerView, renderEntityView, renderRootView, entityFaceViewable } from '../navigator/views.js';
import { buildStorageDescription, resolveStorageDescriptionInputs } from '../lws/storage-description.js';

/**
 * Live reload script - injected into HTML when --live-reload is enabled
 */
const LIVE_RELOAD_SCRIPT = `<script>(function(){var ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//' +location.host+'/.notifications');ws.onopen=function(){ws.send('sub '+location.href)};ws.onmessage=function(e){if(e.data.startsWith('pub '))location.reload()};ws.onclose=function(){setTimeout(function(){location.reload()},1000)}})();</script>`;

// Cache-Control for RDF data responses: let clients keep the body but force
// revalidation via ETag on every use. This prevents stale bodies from leaking
// across auth-state changes (WAC) and closes the mashlib render-race window
// where a cached data variant was served on top-level navigation (#315).
const RDF_CACHE_CONTROL = 'private, no-cache, must-revalidate';

// #7 (Solid #server-patch-n3-accept MUST): stored types PATCH must parse by
// real media type rather than blind JSON — the n3 family (verbatim under
// --lws). JSON/JSON-LD stays on the legacy safeJsonParse-first flow below.
const PATCH_TURTLE_FAMILY = new Set([
  RDF_TYPES.TURTLE, RDF_TYPES.N3, RDF_TYPES.NTRIPLES, RDF_TYPES.NQUADS,
]);

// Detects when the request's Accept header explicitly names a JSON
// media type. Used by the container/index.html branches of GET and HEAD
// to decide whether to surface the embedded JSON-LD data island —
// without this guard, selectContentType's `*/*` arm would divert plain
// browser requests into the RDF branch (#409). Hoisted so GET and HEAD
// can't drift apart silently.
const EXPLICIT_JSON_RE = /\b(application\/ld\+json|application\/json)\b/i;

/**
 * Inject live reload script into HTML content
 */
function injectLiveReload(content) {
  const html = content.toString();
  // Inject before </body> or at end
  if (html.includes('</body>')) {
    return Buffer.from(html.replace('</body>', LIVE_RELOAD_SCRIPT + '</body>'));
  }
  return Buffer.from(html + LIVE_RELOAD_SCRIPT);
}

/**
 * Get the storage path and resource URL for a request
 * In subdomain mode, storage path includes pod name, URL uses subdomain
 */
function getRequestPaths(request) {
  const urlPath = request.url.split('?')[0];
  // Storage path - includes pod name in subdomain mode
  const storagePath = getEffectiveUrlPath(request);
  // Resource URL - uses the actual request hostname (subdomain in subdomain mode)
  const resourceUrl = `${request.protocol}://${request.hostname}${urlPath}`;
  return { urlPath, storagePath, resourceUrl };
}

/**
 * Read a resource's altr: representations (src/lws/representations.js),
 * filtered to what the REQUESTING client is authorized to READ (Task 9 —
 * no-oracle discipline: an alternate the client can't read must be absent
 * from both the linkset advertisement and negotiateProfile's search set,
 * not merely 403 on request). Resolves the request's own identity via
 * getWebIdFromRequestAsync, same pattern as src/handlers/type-index.js —
 * independent of request.config.public, which only bypasses the blanket
 * preHandler gate, not this explicit per-alternate checkAccess call.
 */
async function authorizedRepresentations(request, storagePath, resourceUrl) {
  const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
  return readAuthorizedRepresentations(storage, storagePath + '.meta', resourceUrl, {
    origin: new URL(resourceUrl).origin,
    agentWebId,
    public: !!request.config?.public,
  });
}

/**
 * Referent identity & discovery (Task 3, 2026-07-13): the !stats seam for a
 * minted subject-IRI name (e.g. /id/{slug}) with no stored resource of its
 * own. Reads the pathPrefix->container plane-mapping from the OWNING
 * storage's per-storage pod-config (Task A8, multi-tenant round:
 * storageRootFor (A2) resolves the request's own storage root, then
 * request.podConfigFor(root) (A3) hands back that root's own config handle —
 * NOT the single global request.podConfig, which would only see one tenant's
 * uriSpaces) and resolves the name to its backing resource's urlPath via the
 * pure resolveReferent. no-oracle: returns a target ONLY when it both exists
 * and the requester may READ it (same checkAccess the type-index walk uses,
 * src/lws/authorized-resources.js) — a missing or unreadable target returns
 * null so the caller falls through to the ordinary 404 (never a 303 that
 * leaks existence to an unauthorized requester). --lws-gated.
 */
async function resolveReferentTarget(request, urlPath) {
  if (!request.lwsEnabled) return null;
  const root = await storageRootFor(storage, urlPath);
  const cfg = await request.podConfigFor(root).get();
  const target = resolveReferent(urlPath, cfg.uriSpaces || []);
  if (!target) return null;
  // pod-relative storage path == urlPath in non-subdomain mode
  const targetStoragePath = target;
  const tStat = await storage.stat(targetStoragePath);
  if (!tStat) return null;
  const origin = `${request.protocol}://${request.hostname}`;
  const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
  const { allowed } = await checkAccess({
    resourceUrl: `${origin}${target}`,
    resourcePath: targetStoragePath,
    isContainer: tStat.isDirectory,
    agentWebId,
    requiredMode: AccessMode.READ,
    aclCache: new Map(),
  });
  if (!allowed) return null;
  return { target, origin };
}

// F5 (spec 2026-07-11 §3): the profile-406 body — same RFC 9457 problem+json
// grammar as the media-406 (nonRdfNotAcceptable, src/rdf/serve.js), but
// listing the profiles that WOULD conform so the client can retry correctly.
function profileNotAcceptableProblem(reps, instance) {
  const conforming = [reps?.default, ...(reps?.alternates || [])].filter(Boolean)
    .map((r) => r.profile).filter(Boolean);
  return {
    type: 'about:blank', title: 'Not Acceptable', status: 406,
    detail: `no representation conforms to the requested profile(s). Profiles that conform: ${conforming.length ? conforming.join(', ') : '(none declared)'}.`,
    instance,
  };
}

/**
 * Parse HTTP Range header
 * @param {string} rangeHeader - The Range header value (e.g., "bytes=0-1023")
 * @param {number} fileSize - Total file size in bytes
 * @returns {{ start: number, end: number } | null}
 */
function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return null;
  }

  const range = rangeHeader.slice(6); // Remove 'bytes='

  // Multi-range requests (e.g., "0-100,200-300") are not supported
  // Per RFC 7233, ignore Range header and serve full content instead of 416
  if (range.includes(',')) {
    return null;
  }

  const parts = range.split('-');

  if (parts.length !== 2) {
    return null;
  }

  let start, end;

  if (parts[0] === '') {
    // Suffix range: bytes=-500 (last 500 bytes)
    const suffix = parseInt(parts[1], 10);
    if (isNaN(suffix) || suffix <= 0) return null;
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else if (parts[1] === '') {
    // Open-ended range: bytes=1024- (from 1024 to end)
    start = parseInt(parts[0], 10);
    if (isNaN(start) || start < 0) return null;
    end = fileSize - 1;
  } else {
    // Normal range: bytes=0-1023
    start = parseInt(parts[0], 10);
    end = parseInt(parts[1], 10);
    if (isNaN(start) || isNaN(end) || start < 0 || end < start) return null;
  }

  // Clamp end to file size
  if (end >= fileSize) {
    end = fileSize - 1;
  }

  // Check if range is satisfiable
  if (start > end || start >= fileSize) {
    return null;
  }

  return { start, end };
}

/**
 * Compute a content-type-aware ETag. When mashlib will wrap an RDF
 * resource in HTML, the response body differs from the raw resource,
 * so the ETag must differ too — otherwise browsers confuse cached
 * JSON-LD with the HTML variant despite Vary: Accept (#456).
 */
function getMashlibEtag(request, stats, storagePath) {
  const storedType = stats.isDirectory ? 'application/ld+json' : getContentType(storagePath);
  // Task 6 (spec 2026-07-15): the navigator's generic entity face replaces
  // mashlib for FILES once --lws is on (mirrors the container's willMashlib
  // gate, src/handlers/resource.js ~line 617) — scope to !request.lwsEnabled
  // so this predicate always reflects what will ACTUALLY be served. Every
  // caller keyed off willServeMashlib (predictFileEtag's early return,
  // handleGet's conversionPending, handleHead's isMashlibResponse) would
  // otherwise still bake in the '-html' etag suffix / mashlib content-type
  // for a request the entity-face arm below actually handles.
  const willServeMashlib = !request.lwsEnabled
    && shouldServeMashlib(request, request.mashlibEnabled, storedType);
  const effectiveEtag = willServeMashlib
    ? stats.etag.replace(/"$/, '-html"')
    : stats.etag;
  return { willServeMashlib, effectiveEtag };
}

// Task 10 (probe-#6 F2): one strong ETag covering every representation of a
// resource let a format-switching client 304-revalidate a wrong-format
// cache entry, and a WAC-filtered listing varied by requester under one
// shared ETag. variantEtag suffixes the mashlib '-html' precedent above
// for RDF representations that DIFFER from what's stored — own-format
// reads (Task 1's short-circuit: bytes are bytes) keep the bare
// stats.etag. --lws-gated everywhere it's applied below.
const VARIANT_KEYS = {
  [RDF_TYPES.TURTLE]: 'ttl',
  [RDF_TYPES.NTRIPLES]: 'nt',
  [RDF_TYPES.NQUADS]: 'nq',
  [RDF_TYPES.LWS_JSON]: 'lws',
  [RDF_TYPES.LINKSET]: 'ls',
  // P3 (LWS media-type MUST): the plain-application/json LABEL of a JSON-LD
  // container listing needs its own variant key so it revalidates
  // independently of the application/ld+json label (RFC 9110 §8.8.3) — same
  // bytes, different Content-Type, different cache entry. Container-listing
  // key only (containerListingEtag, keyed off a container's stats.etag); the
  // file-arm '-json' conversion suffix (predictFileEtag, keyed off a FILE's
  // stats.etag) never shares a base etag with this, so the reused string
  // suffix can't collide across the two code paths.
  'application/json': 'json',
};

function variantEtag(etag, key) {
  return etag.replace(/"$/, `-${key}"`);
}

// Container-listing ETag: representation variant (per the served content
// type) + an 8-char md5 of the sorted VISIBLE member names. WAC-filtered
// listings vary by requester (S1) — an anon and an owner listing of the
// same container must not share one ETag. `visKey` is null when the
// caller didn't filter (public mode, or --lws off).
function containerListingEtag(etag, contentType, visKey) {
  const repKey = VARIANT_KEYS[contentType];
  const e = repKey ? variantEtag(etag, repKey) : etag;
  return visKey ? variantEtag(e, visKey) : e;
}

// Predicts a FILE GET's eventual representation ETag from sync,
// content-independent inputs only (stored type / Accept / URL) — the same
// derivation the real --lws serving arm below runs (algebraically
// equivalent to serve.js's own-format check: a real conversion happens
// exactly when the negotiated target differs from the stored type — see
// isOwnFormat in src/rdf/serve.js). Lets the early If-None-Match check
// compare against the right variant before the file is read, so a
// format-switching client can't 304-revalidate a wrong-format cache entry;
// the real branches below reuse this same value, so the header and the
// 304 comparison never drift apart.
// The negotiation algebra shared by predictFileEtag, the --lws quads
// serving arm, and negotiateHeadFileContentType (was triplicated — Task 13
// hygiene): negotiate a target quads format from Accept via selectContentType's
// 3-arg (lws) form, applying the `.ttl`-as-DEFAULT-not-override fallback (an
// explicit Accept for another negotiable quads format still wins). Returns
// undefined when the negotiated type isn't a quads target (e.g. JSON-LD) —
// callers fall through to their own arm.
function negotiateQuadsTarget(acceptHeader, connegEnabled, lwsEnabled, urlPath) {
  const negotiated = selectContentType(acceptHeader, connegEnabled, lwsEnabled);
  // B1: an explicit application/ld+json (or application/json) Accept always wins
  // over the .ttl-extension default — the default applies only when Accept is
  // absent/generic, never as an override of an explicit JSON-LD request.
  const explicitJson = EXPLICIT_JSON_RE.test(acceptHeader || '');
  const negotiatedLws = QUADS_OUTPUTS[negotiated]
    ? negotiated
    : (urlPath.endsWith('.ttl') && !explicitJson ? RDF_TYPES.TURTLE : negotiated);
  return QUADS_OUTPUTS[negotiatedLws];
}

// Shared GET/HEAD navigator decisions (review follow-up to Task 8): the two
// predicates were being computed once for GET's container branch
// (~predictFileEtag's siblings below) and re-derived inline in HEAD's
// container branch — the exact duplicate-logic drift class Task 8 fixed for
// the '-nav'/'-navroot' ETag suffix itself. Extracted here so predict and
// serve on BOTH methods call the SAME functions, following the
// predictFileEtag precedent (one function, two call sites) instead of
// re-deriving.
function willServeNavigatorView(request) {
  return request.lwsEnabled && browserWantsHtml(request);
}
function willServeRootStorageView(request, urlPath) {
  return willServeNavigatorView(request) && urlPath === '/' && request.query?.view === 'nav';
}

// Final-review I3: the face dispatch (GET ~line 1166, HEAD ~line 2128)
// trusts advertisedReps.alternates from .meta; filterReadableAlternates
// (src/lws/representations.js) WAC-checks a same-origin href but never
// existence-checks it — checkAccess resolves a missing path via
// container-default ACL, so a dead href survives the authz filter and the
// dispatch 303s to it forever (a permanent 303->404 loop once the target is
// deleted or never materialized). Existence-gate the dispatch itself so a
// stale face falls through to the entity face / raw serving instead.
// Alternates reaching here are already same-origin-only by construction
// (filterReadableAlternates drops off-origin hrefs before this point), so a
// plain urlToStoragePath (path-mode pathname, same caveat as that filter)
// is safe to reuse here without re-deriving an origin check.
async function faceHrefIsLive(href) {
  try { return await storage.exists(urlToStoragePath(href)); } catch { return false; }
}

function predictFileEtag(request, stats, effectiveEtag, willServeMashlib, storagePath, urlPath, connegEnabled) {
  if (!request.lwsEnabled || willServeMashlib) return effectiveEtag;
  const storedContentType = getContentType(storagePath);
  // Task 6 (spec 2026-07-15): a browser-shaped request is intercepted by the
  // entity face (or its 303 face-dispatch sibling, Task 4) BEFORE any RDF/
  // linkset negotiation runs below — mirrors the actual serving order, so
  // predicting here keeps this the SAME value the entity-face arm itself
  // emits (Task 5's fix, applied to files: fold the variant in before the
  // early If-None-Match check, not after it, so a repeat entity-face GET can
  // 304). Over-approximates "will render the entity view": a declared
  // text/html alternate 303s instead — but that path never emits an ETag, so
  // a client can never be holding a '-nav' validator for it to wrongly
  // 304 against; see the entity-face arm's own re-check for the full
  // argument covering the F3/conversion deferral corners.
  // Review fix: the entity face only fires by default for data types
  // (entityFaceViewable) — media/binary fall through to native serving with
  // no '-nav' variant — OR unconditionally when the request is explicit
  // (?view=nav). Mirrors the arm's own gate (~line 1094) and its HEAD-parity
  // twin (isEntityFaceResponse) exactly, so the predicted and emitted ETags
  // never drift apart.
  if (browserWantsHtml(request) && (request.query?.view === 'nav' || entityFaceViewable(storedContentType))) {
    return variantEtag(stats.etag, 'nav');
  }
  const acceptHeader = request.headers.accept || '';
  if (selectContentType(acceptHeader, connegEnabled) === RDF_TYPES.LINKSET) {
    return variantEtag(stats.etag, 'ls');
  }
  // #5 (RFC 9110 §8.8.3 / LWS ETag MUST): keyed on the negotiation surface the
  // serving arm actually runs (this function already early-returns unless
  // lwsEnabled, and --lws mandates negotiation — spec §4a), and covering BOTH
  // conversion arms: quads targets get their VARIANT_KEYS suffix, the JSON-LD
  // conversion of a non-JSON-LD source gets '-json'. Before this, Turtle
  // bytes and their JSON-LD conversion shared one bare ETag (cross-variant
  // 304 reuse), and --lws-without---conneg collapsed every variant.
  if (isRdfSourceType(storedContentType)) {
    const quadsTarget = negotiateQuadsTarget(acceptHeader, true, true, urlPath);
    if (quadsTarget && quadsTarget !== storedContentType) {
      return variantEtag(stats.etag, VARIANT_KEYS[quadsTarget]);
    }
    if (!quadsTarget && storedContentType !== RDF_TYPES.JSON_LD) {
      return variantEtag(stats.etag, 'json');   // the ld+json conversion arm (~line 1097)
    }
  }
  return stats.etag;
}

// #4 (RFC 9110 §13.2.2): a real RDF conversion can still 406 (parse-fail /
// named-graph lossiness), and that outcome needs the bytes — so the zero-I/O
// early 304 defers whenever a conversion arm will run; the arm re-checks
// If-None-Match only after its outcome is known. Own-format reads (bytes are
// bytes) can never 406 and keep the early check. Mirrors predictFileEtag's
// negotiation exactly (same negotiateQuadsTarget call shape) — one seam for
// both GET and HEAD.
function pendingConversion(request, storagePath, urlPath) {
  if (!request.lwsEnabled) return false;
  const stored = getContentType(storagePath);
  if (!isRdfSourceType(stored)) return false;
  const acceptHeader = request.headers.accept || '';
  if (selectContentType(acceptHeader, true) === RDF_TYPES.LINKSET) return false; // generated, never 406s
  const quadsTarget = negotiateQuadsTarget(acceptHeader, true, true, urlPath);
  if (quadsTarget) return !(QUADS_OUTPUTS[stored] === quadsTarget && stored !== RDF_TYPES.N3); // isOwnFormat mirror
  return stored !== RDF_TYPES.JSON_LD;   // ld+json target: converts unless self
}

/**
 * Handle GET request
 */
export async function handleGet(request, reply) {
  const { urlPath, storagePath, resourceUrl } = getRequestPaths(request);
  const stats = await storage.stat(storagePath);

  if (!stats) {
    // Task 3: a minted subject-IRI name (e.g. /id/{slug}) with no stored
    // resource of its own — try the uriSpace 303 resolver BEFORE the plain
    // 404, so a non-resolving name still 404s exactly as before.
    const referent = await resolveReferentTarget(request, urlPath);
    if (referent) {
      const location = `${referent.origin}${referent.target}`;
      return reply.code(303).header('Location', location).header('Link', `<${location}>; rel="canonical"`).send();
    }
    const origin = request.headers.origin;
    const connegEnabled = request.connegEnabled || false;
    const headers = getNotFoundHeaders({ resourceUrl, origin, connegEnabled, lwsEnabled: request.lwsEnabled });
    Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
    return reply.code(404).send({ error: 'Not Found' });
  }

  const connegEnabled = request.connegEnabled || false;
  // Spec §4a: --lws mandates the negotiation surface; conneg is implied by it.
  const negotiate = connegEnabled || request.lwsEnabled;
  const { willServeMashlib, effectiveEtag } = getMashlibEtag(request, stats, storagePath);
  // Task 10 (probe-#6 F2): the representation-specific ETag a FILE GET will
  // actually emit, predicted up front (see predictFileEtag) — unused for
  // containers, whose listing ETag depends on WAC-filtered membership and
  // is computed further down once entries are read.
  const fileEtag = stats.isDirectory ? null
    : predictFileEtag(request, stats, effectiveEtag, willServeMashlib, storagePath, urlPath, connegEnabled);
  // Spec §3 (RFC 9110 §13.2.2): preconditions apply only to requests that
  // would otherwise succeed — a 304 must never preempt a pending 406.
  // storedContentType is a cheap sync lookup (file extension only, no I/O),
  // safe to hoist here; the file-serving arm below reuses this same const
  // instead of redeclaring it. wouldNotNegotiate mirrors the F3 media gate's
  // predicate (~line 1069); hasAcceptProfile flags requests whose profile
  // outcome isn't known yet (resolved later, at the Accept-Profile block) —
  // both defer the 304 decision instead of guessing.
  const storedContentType = stats.isDirectory ? null : getContentType(storagePath);
  // why: a conservative SUPERSET of the real F3 gate (~line 1144) — it
  // intentionally omits that gate's `looksHtml` byte-sniff exception, which
  // reads the body to decide whether HTML-looking non-RDF content degrades
  // to a 200 instead of a 406. Sniffing here would mean reading bytes before
  // knowing whether a 304 will discard them, which breaks the zero-I/O
  // early-check invariant HEAD depends on (HEAD must not pay I/O a 304 would
  // make wasted work, ~line 1521). Net effect: a non-RDF resource whose
  // bytes look like HTML, requested with an unsatisfiable specific Accept +
  // If-None-Match, forgoes this early 304 and falls through to a full 200
  // (the real F3 gate below still degrades it to 200, never a wrong 406).
  // Safe-direction per RFC 9110 §13.2.2 — never a wrong 304, never a wrong
  // 406 — just a missed cache-revalidation optimization in a narrow corner,
  // accepted deliberately rather than adding a body-read to this early check.
  const wouldNotNegotiate = !stats.isDirectory && request.lwsEnabled
    && !isRdfSourceType(storedContentType)
    && !acceptSatisfiable(request.headers.accept || '', storedContentType);
  const hasAcceptProfile = !!(request.lwsProfileConneg && request.headers['accept-profile']);
  // #4 (RFC 9110 §13.2.2): a real RDF conversion (quads or ld+json arm,
  // ~line 1073/1097) can still 406 on parse-fail / named-graph lossiness —
  // defer the early 304 until that arm knows its outcome (re-check lives in
  // the serving arm itself, right after `served.ok` is known).
  const conversionPending = !stats.isDirectory && !willServeMashlib && pendingConversion(request, storagePath, urlPath);

  // For non-containers, check If-None-Match early using the predicted
  // representation ETag (Task 10). For containers, defer the check until
  // we know which branch (index.html vs listing vs mashlib) will run —
  // each uses a different ETag source (#456). Deferred here too when a 406
  // gate hasn't resolved yet (wouldNotNegotiate), Accept-Profile was sent
  // (hasAcceptProfile — the profile-negotiation block below decides; the
  // deferred re-check sits right after it resolves, spec §3), a real
  // conversion is pending (conversionPending — re-checked in the serving
  // arm), or the request is lws browser-shaped (final-review I1): predictFileEtag's
  // '-nav' suffix is a same-value over-approximation that's blind to a
  // text/html alternate declared AFTER the client cached that etag — so a
  // stale '-nav' If-None-Match must never short-circuit here. The face
  // dispatch (~line 1166) never emits an ETag itself (a 303 always wins for
  // a live face) and the entity-face arm's own re-check (~line 1201) is
  // what actually decides 304 vs 303 once dispatch is known.
  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch && !stats.isDirectory && !wouldNotNegotiate && !hasAcceptProfile && !conversionPending
      && !(request.lwsEnabled && browserWantsHtml(request))) {
    const check = checkIfNoneMatchForGet(ifNoneMatch, fileEtag);
    if (!check.ok && check.notModified) {
      reply.header('ETag', fileEtag);
      reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
      return reply.code(304).send();
    }
  }

  const origin = request.headers.origin;

  // Handle container
  if (stats.isDirectory) {
    // Check for index.html (serves as both profile and container representation)
    const indexPath = storagePath.endsWith('/') ? `${storagePath}index.html` : `${storagePath}/index.html`;
    const indexExists = await storage.exists(indexPath);
    const acceptHeader = request.headers.accept || '';

    // A2 (spec 2026-07-11 §4): index.html shadows the listing only for
    // requests that can accept an HTML answer. Under --lws, a non-HTML
    // Accept escapes the shadow and falls through to the real listing
    // branch below — lws+json/linkset/turtle/quads all become reachable
    // there (including the WAC filter and A1 alternates), and rel="linkset"
    // is no longer suppressed since the affordance is now honest.
    // ?view=nav (Task 5, spec 2026-07-15) is a second escape: an explicit
    // request for the navigator view must reach the listing branch below
    // even when index.html exists and the Accept is HTML-shaped. Folded
    // into the SAME `request.lwsEnabled &&` guard as the non-HTML escape
    // above (not a bare `&& query.view !== 'nav'` tacked on unconditionally)
    // — a non-lws pod must stay byte-identical to pre-Task-5 behavior, and
    // an unguarded clause would let `?view=nav` skip the shadow there too.
    if (indexExists && !(request.lwsEnabled && (!acceptsHtml(acceptHeader) || request.query?.view === 'nav'))) {
      // Serve index.html (contains JSON-LD structured data)
      const content = await storage.read(indexPath);
      const indexStats = await storage.stat(indexPath);

      // Deferred 304 check for index.html containers (#456)
      const indexEtag = indexStats?.etag || stats.etag;
      if (ifNoneMatch) {
        const check = checkIfNoneMatchForGet(ifNoneMatch, indexEtag);
        if (!check.ok && check.notModified) {
          reply.header('ETag', indexEtag);
          reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled));
          return reply.code(304).send();
        }
      }

      // Pick the negotiated RDF type using q-aware Accept parsing. The
      // naive `acceptHeader.includes('text/turtle')` we used to do here
      // ignored q-weights — `Accept: application/ld+json, text/turtle;q=0.1`
      // would still pick Turtle even though JSON-LD was preferred (#325).
      const negotiated = connegEnabled
        ? selectContentType(acceptHeader, true)
        : null;
      const wantsTurtle = negotiated === RDF_TYPES.TURTLE
        || negotiated === RDF_TYPES.N3
        || negotiated === 'application/n-triples';
      // Only treat as JSON-LD when Accept *explicitly* asks for JSON.
      // selectContentType doesn't recognize text/html or
      // application/xhtml+xml, so for a browser Accept like
      // `text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8`
      // it walks past those unsupported types and lands on `*/*`, which
      // returns JSON-LD — diverting plain browser GETs into the RDF
      // branch and serving the embedded data island instead of the
      // index.html body. Mirrors the HEAD-handler logic below (#409).
      const explicitJson = EXPLICIT_JSON_RE.test(acceptHeader);
      const wantsJsonLd = negotiated === RDF_TYPES.JSON_LD && explicitJson;

      if (wantsTurtle || wantsJsonLd) {
        // Extract JSON-LD from HTML data island
        try {
          const htmlStr = content.toString();
          const jsonLdMatch = htmlStr.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
          if (jsonLdMatch) {
            const jsonLd = safeJsonParse(jsonLdMatch[1]);

            if (wantsTurtle) {
              // Convert to Turtle — under --lws ride the dataset serving arm
              // (real parser + n3 writer); the island is already parsed, so
              // re-encode it. Legacy fromJsonLd stays for --lws-off pods.
              let turtleContent;
              if (request.lwsEnabled) {
                const served = await serveStoredRdf({
                  bytes: Buffer.from(JSON.stringify(jsonLd)), targetType: RDF_TYPES.TURTLE, baseIri: resourceUrl,
                });
                if (!served.ok) throw new Error(served.problem.detail);   // existing catch falls through to HTML — islands degrade, never 406
                turtleContent = served.content;
              } else {
                ({ content: turtleContent } = await fromJsonLd(jsonLd, 'text/turtle', resourceUrl, true));
              }

              const headers = getAllHeaders({
                isContainer: true,
                etag: indexStats?.etag || stats.etag,
                contentType: 'text/turtle',
                origin,
                resourceUrl,
                connegEnabled,
                lwsEnabled: request.lwsEnabled,
                storageRootPath: request.storageRootPath
              });
              headers['Cache-Control'] = RDF_CACHE_CONTROL;

              Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
              return reply.send(turtleContent);
            } else {
              // Return JSON-LD directly. P3 (LWS media-type MUST, task-9
              // review): the SAME label swap the listing branch applies
              // (~line 555) — plain application/json is the identical
              // data-island payload under its own label when the client
              // prefers it (body untouched). Mirrors HEAD's shadowActive
              // branch (~line 1594), which stamps this label onto
              // `indexStats.etag` with NO variant suffix — so this branch
              // keeps that same bare etag rather than adopting the
              // listing's containerListingEtag/VARIANT_KEYS treatment;
              // matching HEAD (not the listing) is what keeps GET==HEAD
              // (#552) for the shadowed case.
              const islandContentType = (request.lwsEnabled && prefersPlainJson(acceptHeader))
                ? 'application/json' : 'application/ld+json';
              const headers = getAllHeaders({
                isContainer: true,
                etag: indexStats?.etag || stats.etag,
                contentType: islandContentType,
                origin,
                resourceUrl,
                connegEnabled,
                lwsEnabled: request.lwsEnabled,
                storageRootPath: request.storageRootPath
              });
              headers['Cache-Control'] = RDF_CACHE_CONTROL;

              Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
              return reply.send(JSON.stringify(jsonLd, null, 2));
            }
          }
        } catch (err) {
          // Fall through to serve HTML if conversion fails
          console.error('Failed to convert profile to RDF:', err.message);
        }
      }

      const headers = getAllHeaders({
        isContainer: true,
        etag: indexStats?.etag || stats.etag,
        contentType: 'text/html',
        origin,
        resourceUrl,
        connegEnabled,
        lwsEnabled: request.lwsEnabled,
        storageRootPath: request.storageRootPath
      });

      Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
      // Inject live reload script for index.html
      if (request.liveReloadEnabled) {
        reply.header('Cache-Control', 'no-store');
        reply.removeHeader('ETag');
        return reply.send(injectLiveReload(content));
      }
      return reply.send(content);
    }

    // No index.html, return JSON-LD container listing
    let entries = await storage.listContainer(storagePath);
    // S1 (spec 2026-07-10 §4): WAC-filter the membership per requester
    // before ANY rendering (ldp:contains, lws+json items[], Turtle, mashlib
    // embed all flow from `entries`/`jsonLd`). --public mode has no WAC to
    // filter by; --lws off keeps the upstream unfiltered listing.
    let visKey = null;
    if (request.lwsEnabled && !request.config?.public) {
      const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
      entries = await filterReadableEntries({
        entries: entries || [], containerUrl: resourceUrl, containerStoragePath: storagePath, agentWebId,
      });
      // Task 10 (probe-#6 F2): visibility hash — an anon and an owner
      // listing of the same container must not share one strong ETag.
      visKey = crypto.createHash('md5').update(entries.map(e => e.name).sort().join('\n')).digest('hex').slice(0, 8);
    }

    // Pick the negotiated RDF type using q-aware Accept parsing (#325).
    // LWS media type negotiation is always active when lwsEnabled, even
    // without full conneg — selectContentType handles it independently.
    // Computed here (before the mashlib check and the 304 check below) so
    // Task 10's representation- and visibility-keyed listing ETag is known
    // before either needs it.
    const negotiated = (connegEnabled || request.lwsEnabled)
      ? selectContentType(acceptHeader, connegEnabled, request.lwsEnabled)
      : null;
    const wantsTurtle = negotiated === RDF_TYPES.TURTLE
      || negotiated === RDF_TYPES.N3
      || negotiated === 'application/n-triples';
    // Navigator (Task 5, spec 2026-07-15) replaces mashlib for containers
    // once --lws is on — shouldServeMashlib already requires browserWantsHtml,
    // so scoping willMashlib to !request.lwsEnabled here means: (a) every
    // variable below that's keyed off willMashlib (listingContentType,
    // labeledListingType, listingEtag) resolves through the REAL negotiated
    // listing shape instead of the mashlib-HTML override whenever lwsEnabled,
    // which is exactly the base the navigator's own ETag mirrors (see the
    // navigator arm below); (b) the legacy `if (willMashlib)` block further
    // down becomes reachable only for !request.lwsEnabled pods.
    const willMashlib = !request.lwsEnabled
      && shouldServeMashlib(request, request.mashlibEnabled, 'application/ld+json');
    const listingContentType = willMashlib ? 'text/html'
      : negotiated === RDF_TYPES.LWS_JSON ? RDF_TYPES.LWS_JSON
      : negotiated === RDF_TYPES.LINKSET ? RDF_TYPES.LINKSET
      : (request.lwsEnabled && QUADS_OUTPUTS[negotiated]) ? QUADS_OUTPUTS[negotiated]
      : wantsTurtle ? RDF_TYPES.TURTLE
      : RDF_TYPES.JSON_LD;
    // P3 (LWS media-type MUST): plain application/json is the same JSON-LD
    // payload under its own label — swap the label only, never the body
    // (jsonLd/serializeJsonLd below stay keyed off listingContentType).
    // Gated on listingContentType === JSON_LD so this never mislabels the
    // lws+json/linkset/quads/turtle branches, and on request.lwsEnabled so
    // an --lws-off pod stays byte-identical to pre-Task-9 behavior.
    const labeledListingType = (request.lwsEnabled
      && listingContentType === RDF_TYPES.JSON_LD && prefersPlainJson(acceptHeader))
      ? 'application/json' : listingContentType;
    // --lws-off / mashlib-HTML keep the pre-Task-10 etag source (bare or
    // the mashlib '-html' suffix) — mashlib's embedded listing isn't part
    // of the altr: representation family this task scopes (brief: lws+json/
    // linkset/quads/turtle/ld+json).
    // Review fix (Task 5): predict the navigator arm's '-nav' suffix HERE —
    // mirroring getMashlibEtag's predictive '-html' pattern (~line 224) —
    // BEFORE the deferred If-None-Match check just below, not after it
    // (the bug: computing '-nav' inside the navigator arm meant it always
    // ran after that check had already matched against the un-suffixed
    // etag, so a repeat navigator GET could never 304). willServeNav is
    // the exact predicate the navigator arm (below) guards on, reused
    // there instead of recomputed so the emitted header and the 304
    // comparison can never drift apart. Safe to fold '-nav' into
    // listingEtag unconditionally: every other branch below that also
    // reads listingEtag is reachable only when the navigator arm did NOT
    // fire (it always returns), so the suffix never leaks into a
    // non-navigator representation's ETag — and a machine lws+json
    // conditional GET (willServeNav false) keeps comparing against the
    // un-suffixed etag, so it can never 304 off a stray '-nav' value.
    const willServeNav = willServeNavigatorView(request);
    // Review fix (root-view ETag key): the SAME urlPath==='/' && view==='nav'
    // predicate the render branch below (~line 749) uses to pick the ROOT
    // STORAGE view over the generic container view — hoisted here, before
    // the '-nav' suffix is picked, so predict and serve can't drift (same
    // reasoning as willServeNav itself, one comment block up). Without this,
    // `/` (container view, reachable whenever the seeded index.html is
    // absent — seeding is skip-if-exists) and `/?view=nav` (root view)
    // predicted the identical '-nav' suffix off the same
    // stats.etag+labeledListingType+visKey inputs despite serving different
    // bodies, so an ETag minted from one could bogus-304 the other.
    const willServeRootView = willServeRootStorageView(request, urlPath);
    const listingEtagBase = (request.lwsEnabled && !willMashlib)
      ? containerListingEtag(stats.etag, labeledListingType, visKey)
      : effectiveEtag;
    const listingEtag = willServeNav
      ? variantEtag(listingEtagBase, willServeRootView ? 'navroot' : 'nav')
      : listingEtagBase;

    // Deferred 304 check for container listings (#456) — compared against
    // the representation- and visibility-keyed ETag above (Task 10,
    // probe-#6 F2), not the bare container ETag, so a format-switching or
    // visibility-switching client can't 304-revalidate the wrong variant.
    // Spec §3: containers have no F3 (media) arm, but DO have a profile arm
    // below — when willMashlib is false and Accept-Profile was sent, the
    // outcome isn't known yet, so skip here and re-check once the profile
    // block (below) resolves without a redirect/406. A mashlib response
    // never reaches the profile block, so it's always safe to 304 here.
    if (ifNoneMatch && !(hasAcceptProfile && !willMashlib)) {
      const check = checkIfNoneMatchForGet(ifNoneMatch, listingEtag);
      if (!check.ok && check.notModified) {
        reply.header('ETag', listingEtag);
        reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
        return reply.code(304).send();
      }
    }

    // Navigator (Task 5, spec 2026-07-15): a typed, WAC-filtered,
    // server-rendered HTML container view — takes over for every browser-
    // shaped request once --lws is on (willMashlib above is now scoped to
    // !request.lwsEnabled for exactly this reason, so the legacy mashlib
    // block below can never also fire for this same request). Items come
    // from `entries` (already WAC-filtered above, S1) via the same
    // generateLwsContainer builder the lws+json branch uses, enriched with
    // per-member declared rdf:type (readDeclaredTypes) and authorized
    // alternate-representation "faces" (readAuthorizedRepresentations).
    if (willServeNav) {
      const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
      const originStr = new URL(resourceUrl).origin;
      const isPublicPod = !!request.config?.public;
      const baseStoragePath = storagePath.endsWith('/') ? storagePath : storagePath + '/';
      const baseUrlNav = resourceUrl.endsWith('/') ? resourceUrl : resourceUrl + '/';
      const navListing = generateLwsContainer(resourceUrl, entries || []);
      const items = await Promise.all(navListing.items.map(async (it) => {
        const memberStoragePath = baseStoragePath + it.id.slice(baseUrlNav.length);
        const [rdfTypes, memberReps] = await Promise.all([
          readDeclaredTypes(storage, memberStoragePath),
          readAuthorizedRepresentations(storage, memberStoragePath + '.meta', it.id, {
            origin: originStr, agentWebId, public: isPublicPod,
          }),
        ]);
        // text/html first (a browser reading this listing wants the human
        // face at the top); everything else keeps its declared order.
        const faces = (memberReps.alternates || [])
          .map((r) => ({ href: r.href, format: r.format }))
          .sort((a, b) => (a.format === 'text/html' ? -1 : b.format === 'text/html' ? 1 : 0));
        return { ...it, rdfTypes, faces };
      }));

      // Root/storage view (Task 7, spec 2026-07-15): an explicit `?view=nav`
      // at the pod root renders the LWS storage description (services,
      // capabilities, uriSpace prefixes) beside the same WAC-filtered
      // top-level `items` computed above, instead of the generic container
      // view below. Gated on urlPath (the raw request path), not
      // storagePath — subdomain mode would leave storagePath pod-relative
      // ('/'), but urlPath is always the literal request path. In practice
      // this branch is reachable only via ?view=nav (the seeded index.html
      // shadow, deviation (4), intercepts every other browser GET / before
      // this code is ever reached) — the query check is written explicitly
      // rather than relying on that invariant. willServeRootView is this
      // exact predicate, hoisted above (review fix, root-view ETag key) so
      // the '-navroot' suffix baked into listingEtag and this render choice
      // can never drift apart — reused directly rather than recomputed.
      if (willServeRootView) {
        // Same call the /.well-known/lws-storage route makes (src/server.js)
        // — resolveStorageDescriptionInputs is the shared helper so the two
        // can't drift on what they derive from pod-config's uriSpaces.
        const { profileIndexPath, voidPath, referentResolutionEnabled, uriSpacePrefixes } =
          await resolveStorageDescriptionInputs(request.podConfig, originStr, request.lwsEnabled);
        const sd = buildStorageDescription(originStr, {
          typeIndexEnabled: request.typeIndexEnabled,
          notificationsEnabled: request.notificationsEnabled,
          profileIndexPath,
          voidPath,
          profileConnegEnabled: request.lwsProfileConneg,
          referentResolutionEnabled,
          uriSpacePrefixes,
          mcpEnabled: request.mcpEnabled,
          anonRateLimitMax: request.anonRateLimitMax,
        });
        const rootHtml = renderRootView({ origin: originStr, sd, items });
        const rootHeaders = getAllHeaders({
          isContainer: true,
          etag: listingEtag,
          contentType: 'text/html',
          origin,
          resourceUrl,
          connegEnabled,
          mashlibEnabled: request.mashlibEnabled,
          lwsEnabled: request.lwsEnabled,
          storageRootPath: request.storageRootPath
        });
        rootHeaders['Cache-Control'] = RDF_CACHE_CONTROL;
        Object.entries(rootHeaders).forEach(([k, v]) => reply.header(k, v));
        return reply.type('text/html').send(rootHtml);
      }

      const navConformsTo = await conformsToTargets(storage, storagePath + '.meta', resourceUrl);
      // '-nav' is already folded into listingEtag above (predicted before
      // the deferred If-None-Match check, mirroring getMashlibEtag's
      // predictive '-html' pattern ~line 223) — reused directly here
      // rather than recomputed, so the header and the 304 comparison can
      // never drift apart.
      const html = renderContainerView({ url: resourceUrl, items, conformsTo: navConformsTo });
      const headers = getAllHeaders({
        isContainer: true,
        etag: listingEtag,
        contentType: 'text/html',
        origin,
        resourceUrl,
        connegEnabled,
        mashlibEnabled: request.mashlibEnabled,
        lwsEnabled: request.lwsEnabled,
        storageRootPath: request.storageRootPath
      });
      headers['Cache-Control'] = RDF_CACHE_CONTROL;
      Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
      return reply.type('text/html').send(html);
    }

    const jsonLd = generateContainerJsonLd(resourceUrl, entries || []);

    // Check if we should serve Mashlib data browser for containers
    if (willMashlib) {
      // Phase 1 of #7: also embed the container's JSON-LD listing as a
      // data island so consumers that look for `<script
      // type="application/ld+json">` (search-engine rich-results,
      // archival crawlers, future mashlib zero-fetch path) get the data
      // without a second request. Use compact (no-whitespace) form for
      // the embed so we don't burn bytes against DATA_ISLAND_MAX_BYTES
      // on indentation that nothing will ever read.
      const embedJsonLd = JSON.stringify(jsonLd);
      const html = request.mashlibModule
        ? generateModuleDatabrowserHtml(request.mashlibModule, resourceUrl, { embedJsonLd })
        : generateDatabrowserHtml(
          resourceUrl,
          request.mashlibCdn ? request.mashlibVersion : null,
          { embedJsonLd }
        );
      const headers = getAllHeaders({
        isContainer: true,
        etag: effectiveEtag,
        contentType: 'text/html',
        origin,
        resourceUrl,
        connegEnabled,
        mashlibEnabled: request.mashlibEnabled,
        lwsEnabled: request.lwsEnabled,
        storageRootPath: request.storageRootPath
      });
      headers['X-Frame-Options'] = 'DENY';
      headers['Content-Security-Policy'] = "frame-ancestors 'none'";
      headers['Cache-Control'] = 'no-store';

      Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
      return reply.type('text/html').send(html);
    }

    // Profile conneg (DX-PROF-CONNEG cnpr:http) for the container's RDF
    // listing representations — mirrors the file-GET gate below. Only when
    // explicitly enabled AND the client sent Accept-Profile. index.html and
    // the mashlib data-browser wrapper above already returned early and are
    // out of scope (they're not part of the altr: representation family
    // being negotiated here). Reads the container's client-managed .meta
    // altr: declarations and negotiates against Accept-Profile: redirect/
    // notacceptable return early; self falls through and stamps
    // chosenProfile via getAllHeaders on the listing branches below.
    let chosenProfile = null;
    let advertisedReps = null;
    if (request.lwsProfileConneg && request.headers['accept-profile']) {
      const reps = await authorizedRepresentations(request, storagePath, resourceUrl);
      const neg = negotiateProfile(request.headers['accept-profile'], reps);
      if (neg.outcome === 'redirect') {
        // A redirect is not a 406 — the pre-existing "304 wins over 303"
        // ordering (a cache-valid conditional short-circuits before any
        // profile redirect) is unaffected by spec §3, which only closes the
        // 406 case. Check here, inline, before committing to 303.
        if (ifNoneMatch) {
          const check = checkIfNoneMatchForGet(ifNoneMatch, listingEtag);
          if (!check.ok && check.notModified) {
            reply.header('ETag', listingEtag);
            reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
            return reply.code(304).send();
          }
        }
        reply.header('Link', `<${neg.rep.profile}>; rel="profile"`);
        reply.header('Content-Profile', `<${neg.rep.profile}>`);
        reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
        return reply.code(303).header('Location', neg.rep.href).send();
      }
      if (neg.outcome === 'notacceptable') {
        // DX-PROF-CONNEG/IETF: the 406 advertises what IS available
        // (authz-filtered) so the client can discover supported profiles.
        // Spec §3: 406 wins over 304 — no conditional check here, ever.
        const avail = representationLinks(reps);
        if (avail) reply.header('Link', avail);
        reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
        return reply.code(406).type('application/problem+json')
          .send(JSON.stringify(profileNotAcceptableProblem(reps, resourceUrl), null, 2));
      }
      chosenProfile = neg.outcome === 'self' ? neg.rep.profile : null;
      advertisedReps = reps;   // list-profiles rides every negotiated response (§8.2.1)
    }

    // Deferred 304 (spec §3): reached only when the original check above
    // skipped for hasAcceptProfile — redirect/notacceptable already
    // returned, so the profile arm would succeed. willMashlib is guaranteed
    // false here (that branch returns before this point).
    if (ifNoneMatch && hasAcceptProfile) {
      const check = checkIfNoneMatchForGet(ifNoneMatch, listingEtag);
      if (!check.ok && check.notModified) {
        reply.header('ETag', listingEtag);
        reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
        return reply.code(304).send();
      }
    }

    // A1 (spec §4): container bare 200 gets the same un-negotiated
    // advertisement as files — see the file-GET arm below for the perf
    // rationale. Same `storagePath + '.meta'` the Accept-Profile block
    // above reads (via authorizedRepresentations), so bare and negotiated
    // paths can never diverge on which .meta they resolve.
    if (request.lwsEnabled && !advertisedReps && await storage.exists(storagePath + '.meta')) {
      advertisedReps = await authorizedRepresentations(request, storagePath, resourceUrl);
    }

    // LWS container representation — only when enabled AND explicitly negotiated.
    if (request.lwsEnabled && negotiated === RDF_TYPES.LWS_JSON) {
      const lws = generateLwsContainer(resourceUrl, entries || []);
      const headers = getAllHeaders({
        isContainer: true,
        etag: listingEtag,
        contentType: RDF_TYPES.LWS_JSON,
        origin,
        resourceUrl,
        connegEnabled,
        mashlibEnabled: request.mashlibEnabled,
        lwsEnabled: request.lwsEnabled,
        storageRootPath: request.storageRootPath,
        chosenProfile,
        representations: advertisedReps
      });
      headers['Cache-Control'] = RDF_CACHE_CONTROL;
      const parent = parentContainerUrl(resourceUrl);
      if (parent) {
        headers['Link'] = headers['Link']
          ? `${headers['Link']}, <${parent}>; rel="up"`
          : `<${parent}>; rel="up"`;
      }
      Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
      return reply.send(JSON.stringify(lws, null, 2));
    }

    // LWS per-resource linkset — only when enabled AND explicitly negotiated.
    if (request.lwsEnabled && negotiated === RDF_TYPES.LINKSET) {
      const declaredTypes = await readDeclaredTypes(storage, storagePath);
      const describedByShapes = await describedbyTargets(storage, storagePath + '.meta', resourceUrl);
      const conformsTo = await conformsToTargets(storage, storagePath + '.meta', resourceUrl);
      const representations = advertisedReps || await authorizedRepresentations(request, storagePath, resourceUrl);
      const ls = generateLinkset(resourceUrl, {
        parentUrl: parentContainerUrl(resourceUrl),
        isContainer: true,
        describedByShapes,
        declaredTypes,
        conformsTo,
        representations,
      });
      const headers = getAllHeaders({
        isContainer: true,
        etag: listingEtag,
        contentType: RDF_TYPES.LINKSET,
        origin,
        resourceUrl,
        connegEnabled,
        mashlibEnabled: request.mashlibEnabled,
        lwsEnabled: request.lwsEnabled,
        storageRootPath: request.storageRootPath,
        chosenProfile,
        representations: advertisedReps
      });
      headers['Cache-Control'] = RDF_CACHE_CONTROL;
      Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
      return reply.send(JSON.stringify(ls, null, 2));
    }

    // --lws serving arm for the container listing (spec 2026-07-10 §2). The
    // listing is pod-built JSON-LD (prefixed context, default graph only) so
    // the 406 arms are unreachable; the catch keeps the JSON-LD fallback.
    const quadsTarget = request.lwsEnabled ? QUADS_OUTPUTS[negotiated] : null;
    if (quadsTarget) {
      try {
        const served = await serveStoredRdf({
          bytes: Buffer.from(JSON.stringify(jsonLd)), targetType: quadsTarget, baseIri: resourceUrl,
        });
        if (served.ok) {
          const headers = getAllHeaders({
            isContainer: true,
            etag: listingEtag,
            contentType: served.contentType,
            origin,
            resourceUrl,
            connegEnabled,
            mashlibEnabled: request.mashlibEnabled,
            lwsEnabled: request.lwsEnabled,
            storageRootPath: request.storageRootPath,
            chosenProfile,
            representations: advertisedReps
          });
          headers['Cache-Control'] = RDF_CACHE_CONTROL;
          Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
          return reply.send(served.content);
        }
      } catch (err) {
        console.error('Failed to convert container listing:', err.message);
      }
    }

    if (wantsTurtle) {
      // Convert container JSON-LD to Turtle
      try {
        const { content: turtleContent } = await fromJsonLd(
          jsonLd,
          'text/turtle',
          resourceUrl,
          true
        );

        const headers = getAllHeaders({
          isContainer: true,
          etag: listingEtag,
          contentType: 'text/turtle',
          origin,
          resourceUrl,
          connegEnabled,
          mashlibEnabled: request.mashlibEnabled,
          lwsEnabled: request.lwsEnabled,
          storageRootPath: request.storageRootPath,
          chosenProfile,
          representations: advertisedReps
        });
        headers['Cache-Control'] = RDF_CACHE_CONTROL;

        Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
        return reply.send(turtleContent);
      } catch (err) {
        // Fall through to JSON-LD if conversion fails
        console.error('Failed to convert container to Turtle:', err.message);
      }
    }

    const headers = getAllHeaders({
      isContainer: true,
      etag: listingEtag,
      // P3: only relabel when JSON-LD was the actually-negotiated target —
      // this line is also the unconditional bottom fallback reached after a
      // failed Turtle/quads conversion (listingContentType would be that
      // other type there, not JSON_LD), which must keep serving plain
      // ld+json exactly as before Task 9.
      contentType: listingContentType === RDF_TYPES.JSON_LD ? labeledListingType : 'application/ld+json',
      origin,
      resourceUrl,
      connegEnabled,
      mashlibEnabled: request.mashlibEnabled,
      lwsEnabled: request.lwsEnabled,
      storageRootPath: request.storageRootPath,
      chosenProfile,
      representations: advertisedReps
    });
    headers['Cache-Control'] = RDF_CACHE_CONTROL;

    Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
    return reply.send(serializeJsonLd(jsonLd));
  }

  // Handle resource
  // storedContentType is hoisted above (spec §3 304/406 ordering) — reused
  // here, not recomputed (still the same cheap sync lookup either way).

  // Profile conneg (DX-PROF-CONNEG cnpr:http) — only when explicitly
  // enabled AND the client actually sent Accept-Profile. Gating on the
  // header too (not just the flag) keeps a bare file GET byte-identical
  // to pre-conneg behavior: no .meta read, no negotiation, zero extra
  // I/O (fix round 1 — was running readRepresentations on every file GET).
  // Reads the resource's client-managed .meta altr: declarations and
  // negotiates against Accept-Profile: redirect/notacceptable return
  // early; self falls through and stamps chosenProfile via getAllHeaders
  // on every serve branch below.
  let chosenProfile = null;
  let advertisedReps = null;
  if (request.lwsProfileConneg && request.headers['accept-profile']) {
    const reps = await authorizedRepresentations(request, storagePath, resourceUrl);
    const neg = negotiateProfile(request.headers['accept-profile'], reps);
    if (neg.outcome === 'redirect') {
      // A redirect is not a 406 — the pre-existing "304 wins over 303"
      // ordering (a cache-valid conditional short-circuits before any
      // profile redirect) is unaffected by spec §3, which only closes the
      // 406 case. Check here, inline, before committing to 303.
      if (ifNoneMatch) {
        const check = checkIfNoneMatchForGet(ifNoneMatch, fileEtag);
        if (!check.ok && check.notModified) {
          reply.header('ETag', fileEtag);
          reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
          return reply.code(304).send();
        }
      }
      reply.header('Link', `<${neg.rep.profile}>; rel="profile"`);
      reply.header('Content-Profile', `<${neg.rep.profile}>`);
      reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
      return reply.code(303).header('Location', neg.rep.href).send();
    }
    if (neg.outcome === 'notacceptable') {
      // DX-PROF-CONNEG/IETF: the 406 advertises what IS available
      // (authz-filtered in Task 9) so the client can discover supported profiles.
      // Spec §3: 406 wins over 304 — no conditional check here, ever.
      const avail = representationLinks(reps);
      if (avail) reply.header('Link', avail);
      reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
      return reply.code(406).type('application/problem+json')
        .send(JSON.stringify(profileNotAcceptableProblem(reps, resourceUrl), null, 2));
    }
    // 'none' can still occur here: the gate above only checks the header is
    // truthy, but parseAcceptProfile can yield an empty array for a
    // non-empty-but-content-less header (e.g. "Accept-Profile: ,"), which
    // negotiateProfile reports as { outcome: 'none', rep: null }. Guard so
    // that degrades to normal serving with no stamp instead of throwing.
    chosenProfile = neg.outcome === 'self' ? neg.rep.profile : null;
    advertisedReps = reps;   // list-profiles rides every negotiated response (§8.2.1)
  }

  // Deferred 304 (spec §3): the early check above skipped when Accept-Profile
  // was sent, because the profile outcome wasn't known yet. It's known now —
  // redirect/notacceptable already returned above, so reaching here means the
  // profile arm would succeed. wouldNotNegotiate (media F3 arm) and
  // conversionPending (#4 — a real RDF conversion could still 406 below)
  // still apply unconditionally: never 304 a request either arm would 406.
  if (ifNoneMatch && hasAcceptProfile && !wouldNotNegotiate && !conversionPending) {
    const check = checkIfNoneMatchForGet(ifNoneMatch, fileEtag);
    if (!check.ok && check.notModified) {
      reply.header('ETag', fileEtag);
      reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
      return reply.code(304).send();
    }
  }

  // A1 (spec §4): advertise declared representations on the BARE 200 too —
  // not just the Accept-Profile-negotiated response. A single exists() gate
  // keeps a resource with no .meta at zero extra I/O (the common case); the
  // full authz-filtered read only runs when a .meta is actually there. Every
  // serve branch below (mashlib, range, RDF conneg arm, F3 406, plain-file
  // 200) reads `advertisedReps` via `representations` in getAllHeaders.
  if (request.lwsEnabled && !advertisedReps && await storage.exists(storagePath + '.meta')) {
    advertisedReps = await authorizedRepresentations(request, storagePath, resourceUrl);
  }

  // Face dispatch (spec 2026-07-15): a declared text/html alternate is the resource's
  // human face — browsers 303 there (the fork's alternates are separate resources reached
  // by redirect, mirroring profile-conneg). ?view=nav opts out. --lws only.
  // Final-review I3: existence-gated (faceHrefIsLive) — a declared face that
  // no longer exists falls through to the entity-face arm below instead of
  // 303ing to a dead target.
  if (request.lwsEnabled && browserWantsHtml(request) && request.query?.view !== 'nav') {
    const face = advertisedReps?.alternates?.find(
      (r) => (r.format || '').split(';')[0].trim() === 'text/html');
    if (face && await faceHrefIsLive(face.href)) return reply.code(303).header('Location', face.href).send();
  }

  // Generic entity face (Task 6, spec 2026-07-15): a server-rendered nav
  // view for FILES that have no declared text/html alternate (the face
  // dispatch above already 303'd there if one exists) — replaces mashlib
  // for --lws pods. Scoping getMashlibEtag's willServeMashlib to
  // !request.lwsEnabled (above) means the `else if (shouldServeMashlib(...))`
  // below is reachable only when !request.lwsEnabled, mirroring the
  // container's willMashlib gate (~line 617) — same pattern, file side.
  // Review fix (2026-07-15): by default this arm fires ONLY for data types
  // (entityFaceViewable — RDF/markdown/text) the browser can't render
  // better natively; image/video/audio/pdf/octet-stream/etc. fall through
  // to the raw serving path below, restoring the mashlib precedent
  // (src/mashlib/index.js:380-382). ?view=nav is the explicit escape hatch —
  // it forces the entity face for ANY content type, matching what was
  // asked for. Same predicate predictFileEtag already applied above, so the
  // ETag emitted here always matches what was predicted.
  if (request.lwsEnabled && browserWantsHtml(request)
      && (request.query?.view === 'nav' || entityFaceViewable(storedContentType))) {
    // Defensive re-check (mirrors the file branch's repeated fileEtag
    // pattern at ~1002/1040/1303/1336): the early If-None-Match check above
    // (~line 420) already compares against fileEtag — already '-nav'-suffixed
    // by predictFileEtag — for the common case, but defers whenever
    // wouldNotNegotiate or conversionPending is true (a strict, wildcard-less
    // Accept: text/html, or an RDF-source file). Neither of those deferred
    // re-checks below (the F3 gate / RDF conversion arms) is ever reached
    // once this arm's gate (above) is satisfied — this arm always returns
    // once entered — so this is the ONLY place those deferred cases get a
    // chance to 304. A request that skips this arm (non-viewable content
    // type, no ?view=nav) falls through to those same F3/conversion arms
    // below, which run their own re-check as before.
    if (ifNoneMatch) {
      const check = checkIfNoneMatchForGet(ifNoneMatch, fileEtag);
      if (!check.ok && check.notModified) {
        reply.header('ETag', fileEtag);
        reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
        return reply.code(304).send();
      }
    }
    const [types, describedby, conformsTo, provenance] = await Promise.all([
      readDeclaredTypes(storage, storagePath),
      describedbyTargets(storage, storagePath + '.meta', resourceUrl),
      conformsToTargets(storage, storagePath + '.meta', resourceUrl),
      readProvenance(storage, storagePath),
    ]);
    // advertisedReps is already populated above whenever a .meta exists (A1)
    // or Accept-Profile was negotiated — reuse it rather than re-reading.
    const reps = advertisedReps || await authorizedRepresentations(request, storagePath, resourceUrl);
    // Excerpt: first 2000 chars of the stored bytes, text/* only — binary or
    // otherwise-typed content shows the metadata facts without a body read.
    // Review fix: size-gated BEFORE the read, mirroring the DATA_ISLAND_MAX_BYTES
    // precedent (src/mashlib/index.js:24, applied at ~line 1183 above) — a
    // multi-MB text file would otherwise be read in full just to slice 2000
    // chars. Larger text files show the metadata facts with no preview.
    let excerpt = '';
    if ((storedContentType || '').startsWith('text/') && stats.size <= DATA_ISLAND_MAX_BYTES) {
      const buf = await storage.read(storagePath);
      if (buf) excerpt = buf.toString('utf8').slice(0, 2000);
    }
    const provenanceLines = provenance ? Object.entries(provenance).map(([k, v]) => `${k}: ${v}`) : [];
    const html = renderEntityView({
      url: resourceUrl,
      types,
      conformsTo,
      describedby,
      provenance: provenanceLines,
      reps,
      mediaType: storedContentType || '',
      excerpt,
    });
    const headers = getAllHeaders({
      isContainer: false,
      etag: fileEtag,
      contentType: 'text/html',
      origin,
      resourceUrl,
      connegEnabled,
      mashlibEnabled: request.mashlibEnabled,
      lwsEnabled: request.lwsEnabled,
      storageRootPath: request.storageRootPath,
      chosenProfile,
      representations: advertisedReps
    });
    headers['Cache-Control'] = RDF_CACHE_CONTROL;
    Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
    return reply.type('text/html').send(html);
  }

  // Check if we should serve Mashlib data browser (legacy — reachable only
  // when !request.lwsEnabled; see the entity-face arm above)
  // Only for RDF resources when Accept: text/html is requested
  if (shouldServeMashlib(request, request.mashlibEnabled, storedContentType)) {
    // #7 / #344: embed the resource as a JSON-LD data island so
    // non-mashlib consumers (search-engine rich-results, archival
    // crawlers) get the data without a second request, and so the
    // shape is uniform regardless of the URL extension.
    //
    // JSS stores all RDF as JSON-LD on disk (PUT converts Turtle/N3
    // before write — see the conneg branch in handlePut), so for
    // `.ttl` / `.n3` URLs the bytes on disk are usually already
    // JSON-LD. Try JSON parse first; only fall back to a Turtle parse
    // when that fails (covers files placed on the filesystem
    // out-of-band in their native format).
    //
    // Cap-aware short-circuit: skip the read entirely when the file
    // is already over the embed cap. The island would be dropped
    // anyway, and large RDF resources would otherwise load into
    // memory on every HTML navigation. Other formats (rdf+xml, etc.)
    // are not handled — the wrapper still loads and mashlib
    // XHR-fetches them as before.
    const islandConvertible =
      storedContentType === RDF_TYPES.JSON_LD ||
      storedContentType === RDF_TYPES.TURTLE ||
      storedContentType === RDF_TYPES.N3;
    let embedJsonLd;
    if (islandConvertible && stats.size <= DATA_ISLAND_MAX_BYTES) {
      const buf = await storage.read(storagePath);
      if (buf) {
        if (storedContentType === RDF_TYPES.JSON_LD) {
          // Pass the Buffer through. dataIsland() decodes once when
          // it needs to; we don't pre-validate or pre-decode here.
          embedJsonLd = buf;
        } else {
          // Turtle / N3 URL. JSS stores everything as JSON-LD on
          // disk (PUT converts), so try JSON parse first and pass
          // the *decoded text* through (avoids a second decode
          // inside dataIsland's String() coercion). Fall back to a
          // Turtle parse for files placed on the filesystem
          // out-of-band in their native format.
          const text = buf.toString('utf8');
          try {
            JSON.parse(text);
            embedJsonLd = text;
          } catch {
            try {
              const jsonLd = await turtleToJsonLd(text, resourceUrl);
              embedJsonLd = JSON.stringify(jsonLd);
            } catch {
              // Both parses failed → drop the island. The wrapper
              // still renders and mashlib XHR-fetches the original.
            }
          }
        }
      }
    }
    const html = request.mashlibModule
      ? generateModuleDatabrowserHtml(request.mashlibModule, resourceUrl, { embedJsonLd })
      : generateDatabrowserHtml(
        resourceUrl,
        request.mashlibCdn ? request.mashlibVersion : null,
        { embedJsonLd }
      );
    const headers = getAllHeaders({
      isContainer: false,
      etag: effectiveEtag,
      contentType: 'text/html',
      origin,
      resourceUrl,
      connegEnabled,
      mashlibEnabled: request.mashlibEnabled,
      lwsEnabled: request.lwsEnabled,
      storageRootPath: request.storageRootPath,
      chosenProfile,
      representations: advertisedReps
    });
    headers['X-Frame-Options'] = 'DENY';
    headers['Content-Security-Policy'] = "frame-ancestors 'none'";
    // Don't cache the HTML wrapper - always negotiate fresh
    headers['Cache-Control'] = 'no-store';

    Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
    return reply.type('text/html').send(html);
  }

  // Handle Range requests for media files (video, audio, etc.)
  const rangeHeader = request.headers.range;
  if (rangeHeader && !isRdfContentType(storedContentType)) {
    const range = parseRangeHeader(rangeHeader, stats.size);

    if (range) {
      const { start, end } = range;
      const chunkSize = end - start + 1;

      const headers = getAllHeaders({
        isContainer: false,
        etag: stats.etag,
        contentType: storedContentType,
        origin,
        resourceUrl,
        connegEnabled,
        lwsEnabled: request.lwsEnabled,
        storageRootPath: request.storageRootPath,
        chosenProfile,
        representations: advertisedReps
      });
      headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
      headers['Content-Length'] = chunkSize;

      Object.entries(headers).forEach(([k, v]) => reply.header(k, v));

      const streamResult = storage.createReadStream(storagePath, { start, end });
      if (!streamResult) {
        return reply.code(500).send({ error: 'Stream error' });
      }

      // Handle stream errors that occur during response
      streamResult.stream.on('error', (err) => {
        console.error('Stream error during range response:', err.message);
      });

      return reply.code(206).send(streamResult.stream);
    }
    // If range is null (unsupported format or multi-range), fall through to serve full content
  }

  // LWS per-resource linkset for files — only when enabled AND explicitly negotiated.
  if (request.lwsEnabled && selectContentType(request.headers.accept || '', connegEnabled) === RDF_TYPES.LINKSET) {
    const declaredTypes = await readDeclaredTypes(storage, storagePath);
    const describedByShapes = await describedbyTargets(storage, storagePath + '.meta', resourceUrl);
    const conformsTo = await conformsToTargets(storage, storagePath + '.meta', resourceUrl);
    const representations = advertisedReps || await authorizedRepresentations(request, storagePath, resourceUrl);
    const ls = generateLinkset(resourceUrl, {
      parentUrl: parentContainerUrl(resourceUrl),
      isContainer: false,
      describedByShapes,
      declaredTypes,
      conformsTo,
      representations,
    });
    const headers = getAllHeaders({
      isContainer: false,
      etag: fileEtag,
      contentType: RDF_TYPES.LINKSET,
      origin,
      resourceUrl,
      connegEnabled,
      mashlibEnabled: request.mashlibEnabled,
      lwsEnabled: request.lwsEnabled,
      storageRootPath: request.storageRootPath,
      chosenProfile,
      representations: advertisedReps
    });
    headers['Cache-Control'] = RDF_CACHE_CONTROL;
    Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
    return reply.send(JSON.stringify(ls, null, 2));
  }

  const content = await storage.read(storagePath);
  if (content === null) {
    return reply.code(500).send({ error: 'Read error' });
  }

  // Content negotiation for RDF resources (including HTML with JSON-LD data islands)
  if (negotiate) {
    const contentStr = content.toString();
    const acceptHeader = request.headers.accept || '';
    // Serve Turtle if: URL ends with .ttl OR Accept's q-weighted top
    // RDF type is Turtle/N3 (#325 — naive substring matching ignored
    // q-weights and would pick Turtle whenever it appeared in Accept).
    const negotiated = selectContentType(acceptHeader, true);
    const wantsTurtle = urlPath.endsWith('.ttl')
      || negotiated === RDF_TYPES.TURTLE
      || negotiated === RDF_TYPES.N3
      || negotiated === 'application/n-triples';

    // Check if this is HTML with JSON-LD data island
    const isHtmlWithDataIsland = contentStr.trimStart().startsWith('<!DOCTYPE') ||
                                  contentStr.trimStart().startsWith('<html');

    if (isHtmlWithDataIsland && wantsTurtle) {
      // Extract JSON-LD from HTML data island and convert to Turtle
      try {
        const jsonLdMatch = contentStr.match(/<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/i);
        if (jsonLdMatch) {
          const jsonLd = safeJsonParse(jsonLdMatch[1]);
          // Under --lws ride the dataset serving arm (real parser + n3
          // writer); the island is already parsed, so re-encode it.
          let turtleContent;
          if (request.lwsEnabled) {
            const served = await serveStoredRdf({
              bytes: Buffer.from(JSON.stringify(jsonLd)), targetType: RDF_TYPES.TURTLE, baseIri: resourceUrl,
            });
            if (!served.ok) throw new Error(served.problem.detail);   // existing catch falls through to HTML — islands degrade, never 406
            turtleContent = served.content;
          } else {
            ({ content: turtleContent } = await fromJsonLd(jsonLd, 'text/turtle', resourceUrl, true));
          }

          const headers = getAllHeaders({
            isContainer: false,
            etag: stats.etag,
            contentType: 'text/turtle',
            origin,
            resourceUrl,
            connegEnabled,
            mashlibEnabled: request.mashlibEnabled,
            lwsEnabled: request.lwsEnabled,
            storageRootPath: request.storageRootPath,
            chosenProfile,
            representations: advertisedReps
          });
          headers['Cache-Control'] = RDF_CACHE_CONTROL;

          Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
          return reply.send(turtleContent);
        }
      } catch (err) {
        // Fall through to serve HTML if conversion fails
        console.error('Failed to convert HTML data island to Turtle:', err.message);
      }
    } else if (request.lwsEnabled ? isRdfSourceType(storedContentType) : isRdfContentType(storedContentType)) {
      // --lws serving arm (spec 2026-07-10 §2): real parser + n3 writer,
      // 406 teaching on lossy/failed conversion. The legacy hand-rolled arm
      // below stays byte-identical for --lws-off pods. Gate narrowed to
      // isRdfSourceType under --lws (spec 2026-07-11 §2): plain application/json
      // is not an RDF source — it falls through to generic byte serving below.
      if (request.lwsEnabled) {
        // .ttl is a DEFAULT (Accept absent/generic → Turtle), not an override —
        // an explicit Accept for a different negotiable quads format wins.
        // negotiate (not connegEnabled): the real serving arm below must be
        // reachable under --lws alone, same as the outer gate (spec §4a).
        const quadsTarget = negotiateQuadsTarget(acceptHeader, negotiate, true, urlPath);
        if (quadsTarget) {
          const served = await serveStoredRdf({ bytes: content, sourceContentType: storedContentType, targetType: quadsTarget, baseIri: resourceUrl });
          // #4 (RFC 9110 §13.2.2): the early check deferred here
          // (conversionPending) because this conversion could 406 — the
          // outcome is known now, so a successful conversion still honors a
          // conditional revalidation instead of always paying the 200.
          if (served.ok && ifNoneMatch) {
            const check = checkIfNoneMatchForGet(ifNoneMatch, fileEtag);
            if (!check.ok && check.notModified) {
              reply.header('ETag', fileEtag);
              reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
              return reply.code(304).send();
            }
          }
          const headers = getAllHeaders({
            isContainer: false,
            etag: served.ok ? fileEtag : null,   // #4: no replayable validator for a non-representation
            contentType: served.ok ? served.contentType : 'application/problem+json',
            origin,
            resourceUrl,
            connegEnabled,
            mashlibEnabled: request.mashlibEnabled,
            lwsEnabled: request.lwsEnabled,
            storageRootPath: request.storageRootPath,
            chosenProfile,
            representations: advertisedReps
          });
          headers['Cache-Control'] = RDF_CACHE_CONTROL;
          Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
          if (!served.ok) return reply.code(406).send(JSON.stringify(served.problem, null, 2));
          return reply.send(served.content);
        }
        // JSON-LD target: when the stored bytes are a genuine non-JSON-LD RDF
        // source (B1 — a .ttl/.n3/.nt/.nq resource stores its own bytes,
        // never a JSON-LD envelope), real-convert through the same dataset
        // seam + 406-teaching policy as the quads branch above. The legacy
        // arm below assumes JSON-parseable bytes, which no longer holds.
        if (storedContentType !== RDF_TYPES.JSON_LD) {
          const served = await serveStoredRdf({ bytes: content, sourceContentType: storedContentType, targetType: RDF_TYPES.JSON_LD, baseIri: resourceUrl });
          // #4: same deferred re-check as the quads arm above.
          if (served.ok && ifNoneMatch) {
            const check = checkIfNoneMatchForGet(ifNoneMatch, fileEtag);
            if (!check.ok && check.notModified) {
              reply.header('ETag', fileEtag);
              reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
              return reply.code(304).send();
            }
          }
          const headers = getAllHeaders({
            isContainer: false,
            etag: served.ok ? fileEtag : null,   // #4: no replayable validator for a non-representation
            contentType: served.ok ? served.contentType : 'application/problem+json',
            origin,
            resourceUrl,
            connegEnabled,
            mashlibEnabled: request.mashlibEnabled,
            lwsEnabled: request.lwsEnabled,
            storageRootPath: request.storageRootPath,
            chosenProfile,
            representations: advertisedReps
          });
          headers['Cache-Control'] = RDF_CACHE_CONTROL;
          Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
          if (!served.ok) return reply.code(406).send(JSON.stringify(served.problem, null, 2));
          return reply.send(served.content);
        }
      }
      // Plain JSON-LD file (legacy arm — reached always when --lws off)
      try {
        const jsonLd = safeJsonParse(contentStr);
        // Use Turtle if URL ends with .ttl, otherwise use Accept header preference
        const targetType = wantsTurtle ? 'text/turtle' : selectContentType(acceptHeader, connegEnabled);
        const { content: outputContent, contentType: outputType } = await fromJsonLd(
          jsonLd,
          targetType,
          resourceUrl,
          connegEnabled
        );

        const headers = getAllHeaders({
          isContainer: false,
          etag: stats.etag,
          contentType: outputType,
          origin,
          resourceUrl,
          connegEnabled,
          mashlibEnabled: request.mashlibEnabled,
          lwsEnabled: request.lwsEnabled,
          storageRootPath: request.storageRootPath,
          chosenProfile,
          representations: advertisedReps
        });
        headers['Cache-Control'] = RDF_CACHE_CONTROL;

        Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
        return reply.send(outputContent);
      } catch (e) {
        // If not valid JSON-LD, serve as-is
      }
    }
  }

  // F3 (spec 2026-07-11 §3): teach a 406 when a non-RDF source can't satisfy
  // a specific Accept, instead of silently serving the authored bytes under
  // a mismatched label. Independent of connegEnabled — Accept satisfiability
  // isn't a conversion decision. HTML-looking content is excluded (same
  // sniff as the data-island arm above) — it keeps the existing
  // degrade-to-serve-HTML fallback.
  if (request.lwsEnabled && !isRdfSourceType(storedContentType)
      && !acceptSatisfiable(request.headers.accept || '', storedContentType)) {
    const trimmed = content.toString('utf8').trimStart();
    const looksHtml = trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html');
    if (!looksHtml) {
      // A1: `advertisedReps` is already populated above whenever a .meta
      // exists — reuse it instead of reading + authz-filtering a second time.
      const reps = advertisedReps || await authorizedRepresentations(request, storagePath, resourceUrl);
      const avail = representationLinks(reps);
      if (avail) reply.header('Link', avail);
      const na = nonRdfNotAcceptable(resourceUrl, storedContentType, request.headers.accept,
        !!(reps?.default || reps?.alternates?.length));
      reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
      return reply.code(406).type('application/problem+json').send(JSON.stringify(na.problem, null, 2));
    }
  }

  // Serve content as-is (no conneg or non-RDF resource)
  // For extensionless files (like profile/card), detect HTML by content
  let actualContentType = storedContentType;
  if (storedContentType === 'application/octet-stream') {
    const contentStr = content.toString().trimStart();
    if (contentStr.startsWith('<!DOCTYPE') || contentStr.startsWith('<html')) {
      actualContentType = 'text/html';
    }
  }

  const headers = getAllHeaders({
    isContainer: false,
    etag: stats.etag,
    contentType: actualContentType,
    origin,
    resourceUrl,
    connegEnabled,
    mashlibEnabled: request.mashlibEnabled,
    lwsEnabled: request.lwsEnabled,
    storageRootPath: request.storageRootPath,
    chosenProfile,
    representations: advertisedReps
  });
  if (isRdfContentType(actualContentType)) {
    headers['Cache-Control'] = RDF_CACHE_CONTROL;
  }

  Object.entries(headers).forEach(([k, v]) => reply.header(k, v));

  // Inject live reload script into HTML (disable caching since content is modified)
  if (actualContentType === 'text/html' && request.liveReloadEnabled) {
    reply.header('Cache-Control', 'no-store');
    reply.removeHeader('ETag');
    return reply.send(injectLiveReload(content));
  }
  return reply.send(content);
}

// Cap on how many bytes HEAD will FULLY read to decide a content type.
// GET reads the whole file regardless (it has to send the body anyway),
// but a HEAD on a multi-GB file must not slurp it into memory just to
// report a header. Above the cap, HEAD degrades gracefully per-case
// (see negotiateHeadFileContentType) instead of reading. Bounded
// first-bytes sniffs (HEAD_SNIFF_CHUNK_BYTES via a ranged read) are
// allowed at ANY size — they cost O(1).
const HEAD_FULL_READ_MAX_BYTES = 1024 * 1024;
const HEAD_SNIFF_CHUNK_BYTES = 1024;

// Read the first `bytes` of a file via a ranged stream — O(1) cost
// regardless of file size. Used by HEAD to run GET's "does it look
// like HTML?" sniffs without reading whole files.
function readFirstBytes(storagePath, bytes) {
  return new Promise((resolve) => {
    const result = storage.createReadStream(storagePath, { start: 0, end: bytes - 1 });
    if (!result) return resolve(null);
    const chunks = [];
    result.stream.on('data', (c) => chunks.push(c));
    result.stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    result.stream.on('error', () => resolve(null));
  });
}

/**
 * Mirror handleGet's content-type decision for a FILE so HEAD emits the
 * same Content-Type a GET with the same Accept header would (#552 —
 * RFC 9110 §9.3.2: HEAD should send the same header fields as GET).
 *
 * GET's decision depends on file CONTENT in three places — the
 * HTML-data-island sniff, the JSON-parse-success gate before conneg
 * conversion, and the extensionless-file HTML sniff — so this may read
 * the file, but only when the stored type makes content relevant and
 * the file is within HEAD_FULL_READ_MAX_BYTES.
 *
 * Returns `{ contentType, converted }`. `converted: true` means GET
 * would RE-SERIALIZE the body (Turtle conversion, or JSON-LD
 * re-serialization through fromJsonLd) — its Content-Length would NOT
 * be the on-disk size, so HEAD must omit Content-Length rather than
 * claim stats.size for a body GET never sends. The extensionless HTML
 * sniff only relabels the bytes (served as-is), so it is NOT a
 * conversion.
 *
 * Large files (> HEAD_FULL_READ_MAX_BYTES) degrade per-case instead of
 * being read in full:
 *   - RDF-stored: return the negotiated type WITHOUT the parse gate
 *     (optimistic). The gate only mirrors GET's corrupt-file fallback;
 *     a corrupt >1 MiB RDF document is far rarer than a valid one, so
 *     optimism keeps parity for the common case and confines the
 *     divergence to that corner.
 *   - HTML-looking content (any stored type) + Turtle-preferring
 *     Accept: stay at the stored type (conservative) — the data
 *     island can sit anywhere in the file, so its presence can't be
 *     checked without the full read this cap exists to avoid.
 *   - Extensionless: the HTML sniff only needs the first bytes, so it
 *     runs at ANY size via a bounded ranged read.
 *
 * Known residual divergences (deliberate, all need unusual documents):
 * a parseable-but-unconvertible document (GET's fromJsonLd fails after
 * JSON.parse succeeds → GET falls back to raw bytes), a corrupt
 * >1 MiB RDF file (optimistic path above), and a >1 MiB HTML-looking
 * file carrying a data island (conservative path above).
 */
async function negotiateHeadFileContentType({ request, storagePath, urlPath, stats, acceptHeader, connegEnabled, lwsEnabled = false, resourceUrl = null, advertisedReps = null }) {
  const storedContentType = getContentType(storagePath);
  const fitsFullRead = stats.size <= HEAD_FULL_READ_MAX_BYTES;
  // Spec §4a: --lws mandates the negotiation surface; conneg is implied by it.
  const negotiate = connegEnabled || lwsEnabled;

  if (negotiate) {
    // --lws serving-arm parity (spec 2026-07-10 §2): HEAD answers the same
    // 406 a GET would, and the same converted content-type. Large files stay
    // on the optimistic path (docstring above) — same divergence budget.
    if (lwsEnabled && isRdfSourceType(storedContentType)) {
      // .ttl is a DEFAULT (Accept absent/generic → Turtle), not an override —
      // an explicit Accept for a different negotiable quads format wins (GET parity above).
      const quadsTarget = negotiateQuadsTarget(acceptHeader, true, true, urlPath);
      if (quadsTarget) {
        if (!fitsFullRead) return { contentType: quadsTarget, converted: true };
        const content = await storage.read(storagePath);
        if (content !== null) {
          const check = await checkServable({ bytes: content, sourceContentType: storedContentType, targetType: quadsTarget, baseIri: resourceUrl || `https://head.invalid${urlPath}` });
          if (!check.ok) return { notAcceptable: true };
        }
        return { contentType: quadsTarget, converted: true };
      }
      // JSON-LD target: when the stored bytes are a genuine non-JSON-LD RDF
      // source, GET real-converts through the dataset seam (parity above) —
      // verify parseability (not full serialize) and report application/ld+json;
      // never the legacy 'text/turtle'-by-extension guess below.
      if (storedContentType !== RDF_TYPES.JSON_LD) {
        if (!fitsFullRead) return { contentType: RDF_TYPES.JSON_LD, converted: true };
        const content = await storage.read(storagePath);
        if (content !== null) {
          const check = await checkServable({ bytes: content, sourceContentType: storedContentType, targetType: RDF_TYPES.JSON_LD, baseIri: resourceUrl || `https://head.invalid${urlPath}` });
          if (!check.ok) return { notAcceptable: true };
        }
        return { contentType: RDF_TYPES.JSON_LD, converted: true };
      }
    }

    // Same negotiation as handleGet's file branch (#325 q-aware).
    const negotiated = selectContentType(acceptHeader, true);
    const wantsTurtle = urlPath.endsWith('.ttl')
      || negotiated === RDF_TYPES.TURTLE
      || negotiated === RDF_TYPES.N3
      || negotiated === 'application/n-triples';

    // Legacy JSON-LD gate mirrors GET's ternary (spec 2026-07-11 §2 parity):
    // under --lws, narrowed to isRdfSourceType so plain application/json
    // falls through to the F3 406-teaching gate below instead of a lying
    // 200; --lws-off keeps the old bare isRdfContentType predicate.
    if (lwsEnabled ? isRdfSourceType(storedContentType) : isRdfContentType(storedContentType)) {
      const targetType = wantsTurtle ? 'text/turtle' : selectContentType(acceptHeader, connegEnabled);
      if (!fitsFullRead) {
        // Optimistic large-file path — see docstring.
        return { contentType: targetType, converted: true };
      }
      const content = await storage.read(storagePath);
      if (content !== null) {
        try {
          JSON.parse(content.toString()); // GET only converts when the body parses
          return { contentType: targetType, converted: true };
        } catch { /* not valid JSON-LD → GET serves as-is; fall through */ }
      }
      return { contentType: storedContentType, converted: false };
    }

    // GET's data-island branch is gated on CONTENT ONLY — any file
    // whose body starts with <!DOCTYPE/<html gets the island→Turtle
    // conversion, regardless of stored type (.html, extensionless,
    // .xhtml, …). Mirror that: a 1 KiB ranged sniff decides HTML-ness
    // for O(1) cost on any file, and only HTML-looking content pays
    // the full read for the island check.
    if (wantsTurtle && fitsFullRead) {
      const head = await readFirstBytes(storagePath, HEAD_SNIFF_CHUNK_BYTES);
      const headTrimmed = head === null ? '' : head.trimStart();
      let looksHtml = headTrimmed.startsWith('<!DOCTYPE') || headTrimmed.startsWith('<html');
      let contentStr = null;
      if (!looksHtml && head !== null && headTrimmed === '' && stats.size > HEAD_SNIFF_CHUNK_BYTES) {
        // The chunk was entirely whitespace and the file continues past
        // it — GET trims the FULL body, so the HTML marker may sit
        // beyond the chunk. The file already fits the full-read budget;
        // read it and decide exactly like GET does.
        const content = await storage.read(storagePath);
        if (content !== null) {
          contentStr = content.toString();
          const trimmed = contentStr.trimStart();
          looksHtml = trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html');
        }
      }
      if (looksHtml) {
        // GET converts an HTML data island to Turtle only when the
        // island exists AND its JSON parses; otherwise it serves the
        // document as-is.
        if (contentStr === null) {
          const content = await storage.read(storagePath);
          contentStr = content === null ? null : content.toString();
        }
        if (contentStr !== null) {
          const jsonLdMatch = contentStr.match(/<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/i);
          if (jsonLdMatch) {
            try {
              JSON.parse(jsonLdMatch[1]);
              return { contentType: 'text/turtle', converted: true };
            } catch { /* unparseable island → GET serves as-is; fall through */ }
          }
        }
      }
      // No island conversion → fall through to the as-is path below
      // (HTML-looking extensionless files still get the relabel sniff).
    }
  }

  // F3 (spec 2026-07-11 §3): HEAD mirror of GET's teaching 406 — same
  // predicate, independent of connegEnabled. A bounded O(1) sniff (any file
  // size, mirrors the HEAD_SNIFF_CHUNK_BYTES sniffs above) decides
  // HTML-ness so this path never pays a full read; HTML-looking content
  // keeps the existing degrade-to-serve-HTML fallback.
  if (lwsEnabled && !isRdfSourceType(storedContentType)
      && !acceptSatisfiable(acceptHeader, storedContentType)) {
    const head = await readFirstBytes(storagePath, HEAD_SNIFF_CHUNK_BYTES);
    const headTrimmed = head === null ? '' : head.trimStart();
    const looksHtml = headTrimmed.startsWith('<!DOCTYPE') || headTrimmed.startsWith('<html');
    if (!looksHtml) {
      // HEAD 406 parity: same alternate-list Link as GET (resource.js's F3
      // gate above), body empty (HEAD) — mirrors the sibling Accept-Profile
      // HEAD 406 parity comment in handleHead. A1: reuse `advertisedReps`
      // when handleHead's bare-200 exists() gate already fetched it.
      const reps = advertisedReps || await authorizedRepresentations(request, storagePath, resourceUrl);
      const link = representationLinks(reps);
      return { notAcceptable: true, link };
    }
  }

  // As-is path: GET sniffs extensionless files for HTML by content.
  // Only the first bytes matter, so the sniff runs at any file size
  // via a bounded ranged read. Relabel only — no conversion.
  if (storedContentType === 'application/octet-stream') {
    const head = await readFirstBytes(storagePath, HEAD_SNIFF_CHUNK_BYTES);
    if (head !== null) {
      const t = head.trimStart();
      if (t.startsWith('<!DOCTYPE') || t.startsWith('<html')) {
        return { contentType: 'text/html', converted: false };
      }
    }
  }
  return { contentType: storedContentType, converted: false };
}

/**
 * Handle HEAD request
 */
export async function handleHead(request, reply) {
  const { urlPath, storagePath, resourceUrl } = getRequestPaths(request);
  const stats = await storage.stat(storagePath);

  if (!stats) {
    // Task 3: mirror handleGet's uriSpace 303 resolver, bodyless.
    const referent = await resolveReferentTarget(request, urlPath);
    if (referent) {
      const location = `${referent.origin}${referent.target}`;
      return reply.code(303).header('Location', location).header('Link', `<${location}>; rel="canonical"`).send();
    }
    const origin = request.headers.origin;
    const connegEnabled = request.connegEnabled || false;
    const headers = getNotFoundHeaders({ resourceUrl, origin, connegEnabled, lwsEnabled: request.lwsEnabled });
    Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
    return reply.code(404).send();
  }

  const origin = request.headers.origin;
  const connegEnabled = request.connegEnabled || false;
  // Spec §4a: --lws mandates the negotiation surface; conneg is implied by it.
  const negotiate = connegEnabled || request.lwsEnabled;
  let contentType;
  let headEtag = stats.etag;
  let isMashlibResponse = false;
  let chosenProfile = null;
  let advertisedReps = null;
  // Set when index.html or the mashlib wrapper shadows the container
  // listing — those representations are out of scope for profile conneg
  // (mirrors GET, where both branches return before reaching the
  // negotiation block). Files are never skipped (GET stamps chosenProfile
  // on every file serve branch, mashlib included).
  let skipProfileNegotiation = false;

  if (stats.isDirectory) {
    const indexPath = storagePath.endsWith('/') ? `${storagePath}index.html` : `${storagePath}/index.html`;
    const indexExists = await storage.exists(indexPath);
    const acceptHeader = request.headers.accept || '';
    // A2 (spec 2026-07-11 §4): mirrors GET's shadow-escape gate — index.html
    // shadows the listing only for requests that can accept an HTML answer.
    // A non-HTML Accept under --lws reports as if indexExists were false
    // (real listing's content-type/etag/rel="linkset"), matching what GET
    // actually serves once it falls through to the real listing branch.
    // Task 8 (routed fix, review of Task 5/7): `?view=nav` is GET's SECOND
    // escape (~line 476 `|| request.query?.view === 'nav'`) — an explicit
    // request for the navigator root view must reach the listing branch
    // below even when index.html exists and the Accept is HTML-shaped.
    // Missing here meant a HEAD /?view=nav reported the seeded landing
    // page's ETag while GET served the root storage view under a
    // '-navroot' ETag.
    const shadowActive = indexExists
      && !(request.lwsEnabled && (!acceptsHtml(acceptHeader) || request.query?.view === 'nav'));

    if (negotiate) {
      // HEAD must mirror what GET would emit; otherwise client caches and
      // RDF-aware tooling key off a content-type that doesn't match the
      // body they'll see on the next GET (#325). Use q-aware Accept
      // parsing for both the index.html and listing branches.
      const negotiated = selectContentType(acceptHeader, true);
      const wantsTurtle = negotiated === RDF_TYPES.TURTLE
        || negotiated === RDF_TYPES.N3
        || negotiated === 'application/n-triples';
      const wantsJsonLd = negotiated === RDF_TYPES.JSON_LD;

      if (wantsTurtle) {
        contentType = 'text/turtle';
      } else if (wantsJsonLd) {
        const explicitJson = EXPLICIT_JSON_RE.test(acceptHeader);
        contentType = (shadowActive && !explicitJson) ? 'text/html' : 'application/ld+json';
      } else {
        contentType = shadowActive ? 'text/html' : 'application/ld+json';
      }
    } else if (shadowActive) {
      contentType = 'text/html';
    } else {
      contentType = 'application/ld+json';
    }
    // Mirror GET's LWS negotiation for containers: when lwsEnabled,
    // lws+json/linkset/quads override whatever conneg chose above. GET
    // checks (connegEnabled || lwsEnabled) and negotiates quads 3-arg
    // (selectContentType's lwsEnabled param); HEAD must do the same (F7
    // carryover) — membership graphs are default-graph-only, so there's
    // no 406 risk on HEAD, just content-type parity with what GET serves.
    if (request.lwsEnabled) {
      const lwsNeg = selectContentType(acceptHeader, connegEnabled, request.lwsEnabled);
      if (lwsNeg === RDF_TYPES.LWS_JSON) contentType = RDF_TYPES.LWS_JSON;
      else if (lwsNeg === RDF_TYPES.LINKSET) contentType = RDF_TYPES.LINKSET;
      else if (QUADS_OUTPUTS[lwsNeg]) contentType = QUADS_OUTPUTS[lwsNeg];
    }

    // P3 (LWS media-type MUST): mirror GET's label swap — plain
    // application/json is the same JSON-LD payload under its own label.
    // Only fires when none of the overrides above claimed contentType (i.e.
    // it's still the plain JSON-LD default), so containerListingEtag below
    // gets the same label GET would compute (and thus the same ETag, #552).
    if (request.lwsEnabled && contentType === RDF_TYPES.JSON_LD && prefersPlainJson(acceptHeader)) {
      contentType = 'application/json';
    }

    if (shadowActive) {
      // Mirror GET: containers with index.html use the index file's ETag
      const indexStats = await storage.stat(indexPath);
      headEtag = indexStats?.etag || stats.etag;
      skipProfileNegotiation = true;
    } else if (!request.lwsEnabled && shouldServeMashlib(request, request.mashlibEnabled, 'application/ld+json')) {
      // Container listing via mashlib — suffix the ETag (#456). Scoped to
      // !request.lwsEnabled (Task 8 routed fix, mirrors GET's `willMashlib`
      // ~line 646) — the navigator branch below claims every browser-shaped
      // request once --lws is on, exactly like GET's willServeNav has done
      // since Task 5. Before this scoping, HEAD predicted this legacy
      // '-html' mashlib ETag for a --lws pod while GET served the
      // navigator container/root view under a '-nav'/'-navroot' ETag.
      headEtag = stats.etag.replace(/"$/, '-html"');
      contentType = 'text/html';
      isMashlibResponse = true;
      skipProfileNegotiation = true;
    } else if (request.lwsEnabled) {
      // Task 10 (probe-#6 F2): mirror GET's representation- and
      // visibility-keyed listing ETag — same repKey-per-contentType map
      // (`contentType` is already final above), same WAC-filtered
      // visibility hash, so HEAD and GET agree byte-for-byte. Entries/visKey
      // are shared by both the navigator branch below (Task 8) and the
      // machine-listing branch (browserWantsHtml false) — same WAC-filtered
      // read either way.
      let entries = await storage.listContainer(storagePath);
      let visKey = null;
      if (!request.config?.public) {
        const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
        entries = await filterReadableEntries({
          entries: entries || [], containerUrl: resourceUrl, containerStoragePath: storagePath, agentWebId,
        });
        visKey = crypto.createHash('md5').update(entries.map(e => e.name).sort().join('\n')).digest('hex').slice(0, 8);
      }
      if (willServeNavigatorView(request)) {
        // Task 8 routed fix (review of Task 5/6/7), now sharing the actual
        // predicate functions with GET (review follow-up) instead of just a
        // mirrored comment: willServeNavigatorView/willServeRootStorageView
        // are the SAME functions GET's container branch calls (~line 682/
        // 693) — a container HEAD from a browser must predict the SAME
        // navigator response GET serves (Task 5 container view / Task 7
        // root view), not the legacy plain-listing shape. `contentType`
        // here is still the negotiated real representation type computed
        // above (GET's `labeledListingType`) — containerListingEtag keys
        // off THAT, exactly like GET's listingEtagBase, before the
        // '-nav'/'-navroot' suffix is folded in.
        const willServeRootView = willServeRootStorageView(request, urlPath);
        headEtag = variantEtag(containerListingEtag(stats.etag, contentType, visKey), willServeRootView ? 'navroot' : 'nav');
        contentType = 'text/html';
        skipProfileNegotiation = true;
      } else {
        headEtag = containerListingEtag(stats.etag, contentType, visKey);
      }
    }
  } else {
    const { willServeMashlib, effectiveEtag } = getMashlibEtag(request, stats, storagePath);
    // Task 10 (probe-#6 F2): same prediction GET uses — guarantees
    // HEAD/GET emit identical ETags per variant, including the LWS
    // linkset override applied further below (negotiationConverted block).
    headEtag = predictFileEtag(request, stats, effectiveEtag, willServeMashlib, storagePath, urlPath, connegEnabled);
    isMashlibResponse = willServeMashlib;
    // contentType for files is negotiated AFTER the If-None-Match check
    // below — negotiation may read the file (#552), and GET 304s files
    // before any read, so HEAD must not pay I/O a 304 will discard.
  }

  // Spec §3 (RFC 9110 §13.2.2): preconditions apply only to requests that
  // would otherwise succeed — mirrors handleGet's guard. wouldNotNegotiate
  // is the F3 media-406 predicate negotiateHeadFileContentType applies
  // below (skipped entirely when isMashlibResponse, same as that call);
  // hasAcceptProfile defers to the profile block's outcome (skipped when
  // skipProfileNegotiation — index.html/mashlib containers never reach it).
  const storedContentType = (!stats.isDirectory && !isMashlibResponse) ? getContentType(storagePath) : null;
  // why: same conservative SUPERSET as handleGet's wouldNotNegotiate (see
  // that comment) — omits the real F3 gate's `looksHtml` byte-sniff on
  // purpose. HEAD is where this matters most: a sniff needs the body, and
  // HEAD must not read bytes a 304 would discard (the zero-I/O invariant
  // this whole early-check block exists to protect — see the "HEAD must not
  // pay I/O" note just above). So an HTML-looking non-RDF resource under an
  // unsatisfiable specific Accept + If-None-Match forgoes this early 304 and
  // falls through to 200, same as GET. Safe-direction (RFC 9110 §13.2.2):
  // never a wrong 304, never a wrong 406 — a missed revalidation in a
  // corner, accepted deliberately rather than adding a body-read here.
  const wouldNotNegotiate = !stats.isDirectory && !isMashlibResponse && request.lwsEnabled
    && !isRdfSourceType(storedContentType)
    && !acceptSatisfiable(request.headers.accept || '', storedContentType);
  const hasAcceptProfile = !skipProfileNegotiation && !!(request.lwsProfileConneg && request.headers['accept-profile']);
  // #4 (RFC 9110 §13.2.2): mirrors GET's conversionPending — HEAD's
  // negotiateHeadFileContentType (below) runs the same conversion arm and
  // can answer notAcceptable the same way, so the early 304 defers the same.
  const conversionPending = !stats.isDirectory && !isMashlibResponse
    && pendingConversion(request, storagePath, urlPath);

  // Check If-None-Match using the final ETag (#456). Final-review I1: mirrors
  // GET's added lws-browser-shaped deferral (same over-approximation
  // argument) — scoped to !stats.isDirectory because that's the only case
  // with a later re-check to catch it (the entity-face arm's own re-check,
  // ~line 2159); a browser-shaped HEAD of a CONTAINER has no face dispatch
  // and no later re-check, so it must keep resolving its 304 here, exactly
  // like today.
  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch && !wouldNotNegotiate && !hasAcceptProfile && !conversionPending
      && !(!stats.isDirectory && request.lwsEnabled && browserWantsHtml(request))) {
    const check = checkIfNoneMatchForGet(ifNoneMatch, headEtag);
    if (!check.ok && check.notModified) {
      reply.header('ETag', headEtag);
      reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
      return reply.code(304).send();
    }
  }

  // Profile conneg (DX-PROF-CONNEG cnpr:http) — mirrors the GET gate,
  // placed after the early 304 check, mirroring GET's guard: hasAcceptProfile
  // deferred the early check above exactly when this block runs, so a
  // cache-valid conditional request still short-circuits BEFORE a profile
  // 406 (spec §3, via the deferred re-check below) while a profile redirect
  // gets its own inline conditional check (304-wins-over-303 preserved).
  // Skipped for container representations that index.html/mashlib already
  // shadow (skipProfileNegotiation); files are never skipped, matching GET's
  // universal chosenProfile stamp across every file serve branch.
  if (!skipProfileNegotiation && request.lwsProfileConneg && request.headers['accept-profile']) {
    const reps = await authorizedRepresentations(request, storagePath, resourceUrl);
    const neg = negotiateProfile(request.headers['accept-profile'], reps);
    if (neg.outcome === 'redirect') {
      // A redirect is not a 406 — 304-wins-over-303 is unaffected by spec
      // §3, which only closes the 406 case. Check inline before 303.
      if (ifNoneMatch) {
        const check = checkIfNoneMatchForGet(ifNoneMatch, headEtag);
        if (!check.ok && check.notModified) {
          reply.header('ETag', headEtag);
          reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
          return reply.code(304).send();
        }
      }
      reply.header('Link', `<${neg.rep.profile}>; rel="profile"`);
      reply.header('Content-Profile', `<${neg.rep.profile}>`);
      reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
      return reply.code(303).header('Location', neg.rep.href).send();
    }
    if (neg.outcome === 'notacceptable') {
      // HEAD 406 parity: same alternate-list Link as GET, body empty (HEAD) —
      // but same problem+json Content-Type (F5, spec 2026-07-11 §3).
      // Spec §3: 406 wins over 304 — no conditional check here, ever.
      const avail = representationLinks(reps);
      if (avail) reply.header('Link', avail);
      reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
      return reply.code(406).type('application/problem+json').send();
    }
    chosenProfile = neg.outcome === 'self' ? neg.rep.profile : null;
    advertisedReps = reps;   // list-profiles rides every negotiated response (§8.2.1)
  }

  // Deferred 304 (spec §3): reached only when the original check above
  // skipped for hasAcceptProfile — redirect/notacceptable already returned,
  // so the profile arm would succeed. wouldNotNegotiate and conversionPending
  // (#4 — the RDF conversion arm below could still 406) still apply
  // unconditionally: never 304 a request either arm would 406.
  if (ifNoneMatch && hasAcceptProfile && !wouldNotNegotiate && !conversionPending) {
    const check = checkIfNoneMatchForGet(ifNoneMatch, headEtag);
    if (!check.ok && check.notModified) {
      reply.header('ETag', headEtag);
      reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
      return reply.code(304).send();
    }
  }

  // A1 (spec §4): bare-200 advertisement, GET parity — same exists() gate as
  // handleGet's file/container arms. Skipped where GET never advertises
  // (index.html/mashlib-shadowed containers, skipProfileNegotiation above).
  if (!skipProfileNegotiation && request.lwsEnabled && !advertisedReps
      && await storage.exists(storagePath + '.meta')) {
    advertisedReps = await authorizedRepresentations(request, storagePath, resourceUrl);
  }

  // Face dispatch (spec 2026-07-15): mirrors the GET dispatch above — files
  // only (containers have no altr: "face" concept here); HEAD 303 carries no
  // body. ?view=nav opts out. --lws only.
  // Final-review I3: existence-gated (faceHrefIsLive), same as GET — a
  // deleted face falls through to the entity-face arm below, HEAD parity.
  if (!stats.isDirectory && request.lwsEnabled && browserWantsHtml(request) && request.query?.view !== 'nav') {
    const face = advertisedReps?.alternates?.find(
      (r) => (r.format || '').split(';')[0].trim() === 'text/html');
    if (face && await faceHrefIsLive(face.href)) return reply.code(303).header('Location', face.href).send();
  }

  // Task 6 (spec 2026-07-15) HEAD parity: mirrors GET's entity-face arm —
  // same predicate, same '-nav' headEtag (already folded in by
  // predictFileEtag above). No body on HEAD, so only contentType/Content-
  // Length need to reflect it (below); the legacy mashlib branch stays
  // reachable only when !request.lwsEnabled (isMashlibResponse is already
  // scoped that way via getMashlibEtag).
  // Review fix: same entityFaceViewable/?view=nav gate as GET's arm —
  // storedContentType is already computed above (~line 1894).
  const isEntityFaceResponse = !stats.isDirectory && request.lwsEnabled && browserWantsHtml(request)
    && (request.query?.view === 'nav' || entityFaceViewable(storedContentType));

  let negotiationConverted = false;
  if (!stats.isDirectory) {
    // Mirror GET's content-type for files — including the negotiated
    // Turtle/JSON-LD forms and the extensionless HTML sniff — so HEAD
    // and GET agree (#552, RFC 9110 §9.3.2).
    if (isMashlibResponse) {
      contentType = 'text/html';
    } else if (isEntityFaceResponse) {
      // No RDF negotiation, no mashlib — mirrors GET's entity-face arm.
      // Re-check If-None-Match here (mirroring GET's defensive re-check):
      // wouldNotNegotiate/conversionPending may have deferred the early
      // check above, and negotiateHeadFileContentType's own deferred
      // re-check (below) never runs for this branch.
      contentType = 'text/html';
      if (ifNoneMatch) {
        const check = checkIfNoneMatchForGet(ifNoneMatch, headEtag);
        if (!check.ok && check.notModified) {
          reply.header('ETag', headEtag);
          reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
          return reply.code(304).send();
        }
      }
    } else {
      const negotiation = await negotiateHeadFileContentType({
        request,
        storagePath,
        urlPath,
        stats,
        acceptHeader: request.headers.accept || '',
        connegEnabled,
        lwsEnabled: request.lwsEnabled,
        resourceUrl,
        advertisedReps,
      });
      if (negotiation.notAcceptable) {
        if (negotiation.link) reply.header('Link', negotiation.link);
        reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
        return reply.code(406).type('application/problem+json').send();
      }
      // #4: the early checks above deferred here (conversionPending) because
      // this conversion could 406 — now that negotiateHeadFileContentType
      // resolved without one, re-check If-None-Match before falling through.
      // Review finding 2: for RDF files > HEAD_FULL_READ_MAX_BYTES,
      // negotiateHeadFileContentType already skipped the checkServable probe
      // (its own large-file optimism, docstring above) and resolved
      // optimistically — so this 304 can fire where a real GET would 406.
      // Same #13.2.2 divergence budget as that optimism: a corrupt >1 MiB
      // RDF document is far rarer than a valid one, HEAD-only (a client can
      // only have gotten the variant validator from a prior HEAD), and GET
      // still 406s with no ETag either way. Not a new gap — inherited.
      if (ifNoneMatch && conversionPending) {
        const check = checkIfNoneMatchForGet(ifNoneMatch, headEtag);
        if (!check.ok && check.notModified) {
          reply.header('ETag', headEtag);
          reply.header('Vary', getVaryHeader(connegEnabled, request.mashlibEnabled, request.lwsEnabled));
          return reply.code(304).send();
        }
      }
      contentType = negotiation.contentType;
      negotiationConverted = negotiation.converted;
    }
    // LWS linkset HEAD parity for files: when enabled and explicitly
    // negotiated, set Content-Type to linkset+json (no body on HEAD).
    // Generated representation differs in size from stored file, so
    // mark converted=true to suppress the on-disk Content-Length.
    if (request.lwsEnabled && selectContentType(request.headers.accept || '', connegEnabled) === RDF_TYPES.LINKSET) {
      contentType = RDF_TYPES.LINKSET;
      negotiationConverted = true;
    }
  }

  const headers = getAllHeaders({
    isContainer: stats.isDirectory,
    etag: headEtag,
    contentType,
    origin,
    resourceUrl,
    connegEnabled,
    mashlibEnabled: request.mashlibEnabled,
    lwsEnabled: request.lwsEnabled,
    storageRootPath: request.storageRootPath,
    chosenProfile,
    representations: advertisedReps
  });

  // Mirror GET's Cache-Control for RDF responses (#552 header parity).
  // GET applies RDF_CACHE_CONTROL uniformly wherever the response
  // content type is RDF — container listings (Turtle/JSON-LD) and
  // files (converted or as-is) alike; HTML responses don't get it.
  if (isRdfContentType(contentType)) {
    headers['Cache-Control'] = RDF_CACHE_CONTROL;
  }

  // Content-Length: only set when the file size matches the response body.
  // Mashlib HTML, the entity face, and containers are dynamically
  // generated, and a conneg-converted body (Turtle / re-serialized JSON-LD,
  // #552) has a different length than the on-disk file — omit rather than lie.
  if (!stats.isDirectory && !isMashlibResponse && !isEntityFaceResponse && !negotiationConverted) {
    headers['Content-Length'] = stats.size;
  }

  Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
  return reply.code(200).send();
}

/**
 * Handle PUT request
 */
export async function handlePut(request, reply) {
  // Read-only mode - block all writes
  if (request.config?.readOnly) {
    return reply.code(405).send({ error: 'Method Not Allowed', message: 'Server is in read-only mode' });
  }

  const { urlPath, storagePath, resourceUrl } = getRequestPaths(request);

  // P2 (Solid #server-content-type-missing MUST): a bodied write with no
  // Content-Type must 400, not silently fall through to canAcceptInput('')
  // (which treats absence as accept-anything).
  if (request.lwsEnabled && isBodiedWithoutContentType(request)) {
    return reply.code(400).type('application/problem+json')
      .send(JSON.stringify(missingContentTypeProblem(resourceUrl), null, 2));
  }

  const connegEnabled = request.connegEnabled || false;
  // Spec §4a: --lws mandates the negotiation surface; conneg is implied by it.
  const negotiate = connegEnabled || request.lwsEnabled;

  // Handle container creation via PUT
  if (isContainer(urlPath)) {
    const stats = await storage.stat(storagePath);
    if (stats?.isDirectory) {
      // If container has index.html and PUT sends HTML, rewrite URL to target the
      // index document and delegate to the standard PUT pipeline. This mirrors GET
      // behavior (line 138) which serves index.html for container URLs, and reuses
      // If-Match/If-None-Match, quota checks, and notification handling.
      const indexPath = storagePath.endsWith('/') ? `${storagePath}index.html` : `${storagePath}/index.html`;
      const contentType = request.headers['content-type'] || '';
      if (contentType.includes('text/html') && await storage.exists(indexPath)) {
        const indexUrl = urlPath.endsWith('/') ? `${urlPath}index.html` : `${urlPath}/index.html`;
        // Fastify request.url is a getter, so proxy it with the rewritten path
        const proxied = Object.create(request, { url: { value: indexUrl } });
        return handlePut(proxied, reply);
      }
      // Container exists but no index routing applies - reject
      return reply.code(409).send({ error: 'Cannot PUT to existing container' });
    }

    // Create the container (and any intermediate containers)
    const success = await storage.createContainer(storagePath);
    if (!success) {
      return reply.code(500).send({ error: 'Failed to create container' });
    }

    const origin = request.headers.origin;
    const headers = getAllHeaders({
      isContainer: true,
      origin,
      connegEnabled
    });
    headers['Location'] = resourceUrl;
    Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
    emitChange(request.protocol + '://' + request.hostname, urlPath, 'created');
    return reply.code(201).send();
  }

  const contentType = request.headers['content-type'] || '';

  // ACL resources require a JSON-LD payload (application/ld+json or
  // application/json). Round-trip serialization between JSON-LD and
  // Turtle representations has limitations that can cause data loss
  // when a client PUTs Turtle and later requests Turtle.
  // Other RDF resources are unaffected. The guard fires regardless
  // of conneg setting and also when Content-Type is missing.
  const ctMain = contentType.split(';')[0].trim().toLowerCase();
  const isJsonLd = ctMain === 'application/ld+json' || ctMain === 'application/json';
  if (urlPath.endsWith('.acl') && !isJsonLd) {
    reply.header('Accept', 'application/ld+json, application/json');
    reply.header('Accept-Put', 'application/ld+json, application/json');
    return reply.code(415).send({
      error: 'Unsupported Media Type',
      message: 'ACL resources must be sent as application/ld+json or application/json.'
    });
  }

  // Check if we can accept this input type
  if (!canAcceptInput(contentType, negotiate)) {
    const acceptValue = connegEnabled
      ? 'application/ld+json, application/json, text/turtle, text/n3'
      : 'application/ld+json, application/json';
    reply.header('Accept', acceptValue);
    reply.header('Accept-Put', acceptValue);
    return reply.code(415).send({
      error: 'Unsupported Media Type',
      message: connegEnabled
        ? 'Supported types: application/ld+json, application/json, text/turtle, text/n3'
        : 'Supported types: application/ld+json, application/json (enable conneg for Turtle/N3 support)'
    });
  }

  // Check if resource already exists and get current ETag
  const stats = await storage.stat(storagePath);
  const existed = stats !== null;
  const currentEtag = stats?.etag || null;

  // Check If-Match header (for safe updates)
  const ifMatch = request.headers['if-match'];
  if (ifMatch) {
    const check = checkIfMatch(ifMatch, currentEtag);
    if (!check.ok) {
      return reply.code(check.status).send({ error: check.error });
    }
  }

  // Check If-None-Match header (for create-only semantics)
  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch) {
    const check = checkIfNoneMatchForWrite(ifNoneMatch, currentEtag);
    if (!check.ok) {
      return reply.code(check.status).send({ error: check.error });
    }
  }

  // Get content from request body
  let content = request.body;

  // Handle raw body for non-JSON content types
  if (Buffer.isBuffer(content)) {
    // Already a buffer, use as-is
  } else if (typeof content === 'string') {
    content = Buffer.from(content);
  } else if (content && typeof content === 'object') {
    content = Buffer.from(JSON.stringify(content));
  } else {
    content = Buffer.from('');
  }

  // Spec §2: under --lws, store the submitted bytes verbatim; the name/type
  // gate now runs inside applyLwsWrite (review #2 — the choke point every
  // write surface shares), not here.
  // --lws-off keeps the byte-identical legacy Turtle/N3→JSON-LD conversion.
  const inputType = contentType.split(';')[0].trim().toLowerCase();
  if (!request.lwsEnabled && connegEnabled && (inputType === RDF_TYPES.TURTLE || inputType === RDF_TYPES.N3)) {
    try {
      const jsonLd = await toJsonLd(content, contentType, resourceUrl, connegEnabled, { graphEnvelope: false });
      content = Buffer.from(JSON.stringify(jsonLd, null, 2));
    } catch (e) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid Turtle/N3 format: ' + e.message
      });
    }
  }

  // Check storage quota before writing (skip in public mode - no pod structure)
  const podName = request.config?.public ? null : getPodName(request);
  const oldSize = stats?.size || 0;
  const sizeDelta = content.length - oldSize;

  if (podName && sizeDelta > 0) {
    const { allowed, error } = await checkQuota(podName, sizeDelta, request.defaultQuota || 0);
    if (!allowed) {
      return reply.code(507).send({ error: 'Insufficient Storage', message: error });
    }
  }

  // L3 admission + write + type-capture via the shared LWS core (--lws-gated inside).
  const declared = request.lwsEnabled ? parseTypeLinks(request.headers.link || '') : [];
  const w = await applyLwsWrite({
    storage, storagePath, resourceUrl,
    content,
    contentType: (!request.lwsEnabled && connegEnabled && (inputType === RDF_TYPES.TURTLE || inputType === RDF_TYPES.N3))
      ? RDF_TYPES.JSON_LD : (request.headers['content-type'] || ''),
    declaredTypes: declared,
    lwsEnabled: request.lwsEnabled,
  });
  if (!w.ok) {
    if (w.problem) {
      const reply2 = reply.code(w.problem.status || 400).type('application/problem+json');
      if (w.problem.status === 405) reply2.header('Allow', 'GET, HEAD');
      return reply2.send(JSON.stringify(w.problem, null, 2));
    }
    reply.header('content-type', 'application/problem+json');
    if (w.shapeUrl) reply.header('Link', `<${w.shapeUrl}>; rel="describedby"`);
    return reply.code(400).send(constraintProblem({
      shapeUrl: w.shapeUrl, violations: w.violations, instance: resourceUrl,
    }));
  }
  if (!w.wrote) {
    return reply.code(500).send({ error: 'Write failed' });
  }
  if (w.shapeUrl) request.__lwsShapeUrl = w.shapeUrl;
  if (w.advisories.length) request.__lwsAdvisories = w.advisories;

  // Update quota usage after successful write
  if (podName && sizeDelta !== 0) {
    await updateQuotaUsage(podName, sizeDelta);
  }

  const origin = request.headers.origin;
  const headers = getAllHeaders({ isContainer: false, origin, resourceUrl, connegEnabled, mashlibEnabled: request.mashlibEnabled });
  headers['Location'] = resourceUrl;

  // Append describedby Link when admission resolved a shape (--lws, success path).
  if (request.__lwsShapeUrl) {
    const shapeLink = `<${request.__lwsShapeUrl}>; rel="describedby"`;
    headers['Link'] = headers['Link'] ? `${headers['Link']}, ${shapeLink}` : shapeLink;
  }

  Object.entries(headers).forEach(([k, v]) => reply.header(k, v));

  // Emit change notification for WebSocket subscribers
  if (request.notificationsEnabled) {
    emitChange(resourceUrl);
  }

  // RFC 9111 obsoletes Warning header → advisories ride the success body.
  if (request.__lwsAdvisories) {
    return reply.code(existed ? 200 : 201).send({ advisories: request.__lwsAdvisories });
  }
  return reply.code(existed ? 204 : 201).send();
}

/**
 * Handle DELETE request
 */
export async function handleDelete(request, reply) {
  // Read-only mode - block all writes
  if (request.config?.readOnly) {
    return reply.code(405).send({ error: 'Method Not Allowed', message: 'Server is in read-only mode' });
  }

  const { storagePath, resourceUrl } = getRequestPaths(request);

  // DELETE bypasses applyLwsWrite (no body to gate through writeTypeConsistency)
  // so mirror the System-Managed sidecar rejection here — a client must not be
  // able to delete a server-derived .lwstypes/.lwsprov sidecar either.
  if (request.lwsEnabled && /\.(lwstypes|lwsprov)$/.test(storagePath)) {
    reply.header('Allow', 'GET, HEAD');
    return reply.code(405).type('application/problem+json').send(JSON.stringify({
      type: 'about:blank', title: 'Method Not Allowed', status: 405,
      detail: 'This is a System-Managed sidecar; it is read-only to clients.',
      instance: resourceUrl,
    }, null, 2));
  }

  // Check if resource exists and get current ETag
  const stats = await storage.stat(storagePath);
  if (!stats) {
    const origin = request.headers.origin;
    const connegEnabled = request.connegEnabled || false;
    const headers = getNotFoundHeaders({ resourceUrl, origin, connegEnabled, lwsEnabled: request.lwsEnabled });
    Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
    return reply.code(404).send({ error: 'Not Found' });
  }

  // Check If-Match header (for safe deletes)
  const ifMatch = request.headers['if-match'];
  if (ifMatch) {
    const check = checkIfMatch(ifMatch, stats.etag);
    if (!check.ok) {
      return reply.code(check.status).send({ error: check.error });
    }
  }

  // Get file size before deletion for quota update
  const fileSize = stats.size || 0;

  const success = await storage.remove(storagePath);
  if (!success) {
    return reply.code(500).send({ error: 'Delete failed' });
  }

  // Clean up the server-managed type store so a resource later created
  // at this same path (with no rel="type" Link) doesn't inherit phantom
  // types from this deleted resource. Best-effort — remove() no-ops if
  // the store never existed.
  if (request.lwsEnabled) {
    await storage.remove(typeStorePath(storagePath));
  }

  // Update quota usage (subtract deleted file size)
  const podName = getPodName(request);
  if (podName && fileSize > 0) {
    await updateQuotaUsage(podName, -fileSize);
  }

  const origin = request.headers.origin;
  const headers = getAllHeaders({ isContainer: false, origin, resourceUrl });
  Object.entries(headers).forEach(([k, v]) => reply.header(k, v));

  // Emit change notification for WebSocket subscribers
  if (request.notificationsEnabled) {
    emitChange(resourceUrl);
  }

  return reply.code(204).send();
}

/**
 * Handle OPTIONS request
 */
export async function handleOptions(request, reply) {
  const { urlPath, storagePath, resourceUrl } = getRequestPaths(request);
  const stats = await storage.stat(storagePath);

  const origin = request.headers.origin;
  const connegEnabled = request.connegEnabled || false;
  const headers = getAllHeaders({
    isContainer: stats?.isDirectory || isContainer(urlPath),
    origin,
    resourceUrl,
    connegEnabled,
    lwsEnabled: request.lwsEnabled,
    storageRootPath: request.storageRootPath
  });

  Object.entries(headers).forEach(([k, v]) => reply.header(k, v));
  return reply.code(204).send();
}

/**
 * #7 (Solid #server-patch-n3-accept MUST): PATCH a verbatim-stored
 * Turtle-family resource (resourceExists && storedType is Turtle/N3/NT/NQ).
 * Parses stored bytes -> RDF dataset (toDataset) and applies the parsed
 * patch directly on that dataset (applyPatchToDataset) — no JSON-LD
 * document projection — then serializes back through datasetToFormat so
 * the write lands in the SAME stored format — Content-Type identity is
 * preserved.
 */
async function patchTurtleFamilyResource(request, reply, { storagePath, resourceUrl, storedType, isSparqlUpdate }) {
  const existingContent = await storage.read(storagePath);
  if (existingContent === null) {
    return reply.code(500).send({ error: 'Read error' });
  }

  let dataset;
  try {
    dataset = await toDataset(existingContent, storedType, resourceUrl);
  } catch (e) {
    return reply.code(409).type('application/problem+json').send(JSON.stringify({
      type: 'about:blank', title: 'Conflict', status: 409,
      detail: `the stored document did not parse as ${storedType} (${e.message}).`,
      instance: resourceUrl,
    }, null, 2));
  }

  const patchContent = Buffer.isBuffer(request.body) ? request.body.toString() : request.body;

  if (isSparqlUpdate) {
    let update;
    try {
      update = parseSparqlUpdate(patchContent, resourceUrl);
    } catch (e) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid SPARQL Update: ' + e.message });
    }
    try {
      applyPatchToDataset(dataset, update, false); // SPARQL: bare strings are KNOWN literals
    } catch (e) {
      return reply.code(409).send({ error: 'Conflict', message: 'Failed to apply SPARQL Update: ' + e.message });
    }
  } else {
    let patch;
    try {
      patch = parseN3Patch(patchContent, resourceUrl);
    } catch (e) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid N3 Patch format: ' + e.message });
    }
    // Task 8, contract 2: a non-empty solid:where binds a SINGLE solution into
    // deletes/inserts BEFORE they are applied — zero/multiple solutions 409, so
    // a conditional patch never applies unconditionally. Runs before the write
    // choke point (applyLwsWrite, below), so nothing is stored on rejection.
    if (patch.where && patch.where.length) {
      const w = resolveWhere(dataset, patch, true);
      if (!w.ok) {
        return reply.code(409).type('application/problem+json').send(JSON.stringify({
          type: 'about:blank', title: 'Conflict', status: 409, detail: w.detail, instance: resourceUrl,
        }, null, 2));
      }
      patch = { deletes: w.deletes, inserts: w.inserts, where: [] };
    }
    // Task 8, contract 1: every delete triple MUST already exist — a delete of
    // an absent triple is a 409, not a silent no-op (Solid N3-Patch).
    const exist = patchDeletesExist(dataset, patch, true);
    if (!exist.ok) {
      return reply.code(409).type('application/problem+json').send(JSON.stringify({
        type: 'about:blank', title: 'Conflict', status: 409,
        detail: `N3 Patch delete of a triple absent from the target graph: ${JSON.stringify(exist.missing)}`,
        instance: resourceUrl,
      }, null, 2));
    }
    try {
      applyPatchToDataset(dataset, patch, true); // N3-Patch: bare strings are AMBIGUOUS (IRI or literal)
    } catch (e) {
      return reply.code(409).send({ error: 'Conflict', message: 'Failed to apply patch: ' + e.message });
    }
  }

  const updatedContent = await datasetToFormat(dataset, QUADS_OUTPUTS[storedType] || RDF_TYPES.NQUADS);

  // task-6: route the Turtle-family dataset patch through the shared write
  // choke point (applyLwsWrite) so SHACL admission holds on PATCH — a patch
  // whose RESULT violates the container shape 400s instead of silently 204ing
  // — and .lwstypes/.lwsprov re-derive from the patched bytes. contentType is
  // the RESOURCE's own stored RDF type (storedType), NEVER the patch media
  // type, so subjectTypesFromBody / the gate read the right serialization.
  // (Only reachable under --lws — the dispatch guard sets storedType only when
  // request.lwsEnabled && resourceExists.)
  const w = await applyLwsWrite({
    storage, storagePath, resourceUrl,
    content: Buffer.from(updatedContent),
    contentType: storedType,
    declaredTypes: [],
    lwsEnabled: request.lwsEnabled,
  });
  if (!w.ok) {
    if (w.problem) {
      const r = reply.code(w.problem.status || 400).type('application/problem+json');
      if (w.problem.status === 405) r.header('Allow', 'GET, HEAD');
      return r.send(JSON.stringify(w.problem, null, 2));
    }
    reply.header('content-type', 'application/problem+json');
    if (w.shapeUrl) reply.header('Link', `<${w.shapeUrl}>; rel="describedby"`);
    return reply.code(400).send(constraintProblem({ shapeUrl: w.shapeUrl, violations: w.violations, instance: resourceUrl }));
  }
  if (!w.wrote) {
    return reply.code(500).send({ error: 'Write failed' });
  }

  const origin = request.headers.origin;
  const headers = getAllHeaders({ isContainer: false, origin, resourceUrl, lwsEnabled: request.lwsEnabled, storageRootPath: request.storageRootPath });
  // Append the describedby Link when admission resolved a governing shape —
  // mirrors handlePut's success-path shape advertisement.
  if (w.shapeUrl) {
    const shapeLink = `<${w.shapeUrl}>; rel="describedby"`;
    headers['Link'] = headers['Link'] ? `${headers['Link']}, ${shapeLink}` : shapeLink;
  }
  Object.entries(headers).forEach(([k, v]) => reply.header(k, v));

  if (request.notificationsEnabled) {
    emitChange(resourceUrl);
  }

  // The resource already existed (dispatch precondition) — always 204.
  return reply.code(204).send();
}

/**
 * Handle PATCH request
 * Supports N3 Patch format (text/n3) and SPARQL Update for updating RDF resources
 */
export async function handlePatch(request, reply) {
  // Read-only mode - block all writes
  if (request.config?.readOnly) {
    return reply.code(405).send({ error: 'Method Not Allowed', message: 'Server is in read-only mode' });
  }

  const { urlPath, storagePath, resourceUrl } = getRequestPaths(request);

  // PATCH bypasses applyLwsWrite (never routes through writeTypeConsistency)
  // so mirror the System-Managed sidecar rejection here — a client must not be
  // able to PATCH a server-derived .lwstypes/.lwsprov sidecar either. Mirrors
  // the handleDelete guard above.
  if (request.lwsEnabled && /\.(lwstypes|lwsprov)$/.test(storagePath)) {
    reply.header('Allow', 'GET, HEAD');
    return reply.code(405).type('application/problem+json').send(JSON.stringify({
      type: 'about:blank', title: 'Method Not Allowed', status: 405,
      detail: 'This is a System-Managed sidecar; it is read-only to clients.',
      instance: resourceUrl,
    }, null, 2));
  }

  // P2 (Solid #server-content-type-missing MUST): a bodied write with no
  // Content-Type must 400, not fall through to a guessed patch type.
  if (request.lwsEnabled && isBodiedWithoutContentType(request)) {
    return reply.code(400).type('application/problem+json')
      .send(JSON.stringify(missingContentTypeProblem(resourceUrl), null, 2));
  }

  // Don't allow PATCH to containers
  if (isContainer(urlPath)) {
    return reply.code(409).send({ error: 'Cannot PATCH containers' });
  }

  // Check content type
  const contentType = request.headers['content-type'] || '';
  const isN3Patch = contentType.includes('text/n3') || contentType.includes('application/n3');
  const isSparqlUpdate = contentType.includes('application/sparql-update');
  // P1 (LWS update-resource MUST: JSON Merge Patch, RFC 7386) — --lws only;
  // the --lws-off 415 gate below stays byte-identical (isMergePatch false).
  const isMergePatch = request.lwsEnabled
    && contentType.split(';')[0].trim().toLowerCase() === 'application/merge-patch+json';

  if (!isN3Patch && !isSparqlUpdate && !isMergePatch) {
    // task-6 review #2: the --lws-off base string is byte-identical to the
    // pre-round wording; the merge-patch clause is appended only under --lws.
    return reply.code(415).send({
      error: 'Unsupported Media Type',
      message: 'PATCH requires Content-Type: text/n3 (N3 Patch) or application/sparql-update (SPARQL Update)'
        + (request.lwsEnabled ? ' or application/merge-patch+json (JSON Merge Patch)' : '')
    });
  }

  // Check if resource exists - PATCH can create resources in Solid
  const stats = await storage.stat(storagePath);
  const resourceExists = !!stats;

  // Check If-Match header (for safe updates) - only if resource exists
  if (resourceExists) {
    const ifMatch = request.headers['if-match'];
    if (ifMatch) {
      const check = checkIfMatch(ifMatch, stats.etag);
      if (!check.ok) {
        return reply.code(check.status).send({ error: check.error });
      }
    }
  }

  // #7: a verbatim-stored Turtle-family resource is parsed by its real media
  // type (src/rdf/dataset.js toDataset), not blindly as JSON-LD — the legacy
  // flow below assumes JSON-LD and 409s every Turtle/N3/NT/NQ PATCH target.
  const storedType = (request.lwsEnabled && resourceExists) ? getContentType(storagePath) : null;
  if (storedType && PATCH_TURTLE_FAMILY.has(storedType)) {
    if (isMergePatch) {
      return reply.code(415).type('application/problem+json').send(JSON.stringify({
        type: 'about:blank', title: 'Unsupported Media Type', status: 415,
        detail: `JSON Merge Patch applies to JSON documents; this resource is ${storedType} — use text/n3 (N3 Patch) or application/sparql-update.`,
        instance: resourceUrl,
      }, null, 2));
    }
    return patchTurtleFamilyResource(request, reply, { storagePath, resourceUrl, storedType, isSparqlUpdate });
  }

  // Read existing content or start with empty JSON-LD document
  let document;
  let htmlWrapper = null; // Track HTML wrapper for data island re-embedding

  if (resourceExists) {
    const existingContent = await storage.read(storagePath);
    if (existingContent === null) {
      return reply.code(500).send({ error: 'Read error' });
    }

    const contentStr = existingContent.toString();

    // Check if this is HTML with embedded JSON-LD data island
    if (contentStr.trimStart().startsWith('<!DOCTYPE') || contentStr.trimStart().startsWith('<html')) {
      // Extract JSON-LD from <script type="application/ld+json"> tag
      const jsonLdMatch = contentStr.match(/<script\s+type=["']application\/ld\+json["']\s*>([\s\S]*?)<\/script>/i);

      if (!jsonLdMatch) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'HTML document does not contain a JSON-LD data island'
        });
      }

      try {
        document = safeJsonParse(jsonLdMatch[1]);
        // Save the HTML parts for re-embedding after patch
        const jsonLdStart = contentStr.indexOf(jsonLdMatch[0]) + jsonLdMatch[0].indexOf('>') + 1;
        const jsonLdEnd = jsonLdStart + jsonLdMatch[1].length;
        htmlWrapper = {
          before: contentStr.substring(0, jsonLdStart),
          after: contentStr.substring(jsonLdEnd)
        };
      } catch (e) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'HTML data island contains invalid JSON-LD'
        });
      }
    } else {
      // Try to parse as JSON-LD first
      try {
        document = safeJsonParse(contentStr);
      } catch (e) {
        // Not JSON - might be Turtle, handle with RDF store for SPARQL Update
        if (isSparqlUpdate) {
          // task-6: this legacy Turtle-in-SPARQL fallback is NOT reachable under
          // --lws — a verbatim Turtle-family resource diverts to
          // patchTurtleFamilyResource above (branch a), and the --lws write gate
          // (writeTypeConsistency) refuses ever storing a non-JSON RDF body at a
          // non-Turtle-family / extensionless name, so no --lws resource lands
          // here. It stays a DIRECT storage.write: the --lws-off (or pre-gate)
          // path, kept byte-identical (no admission on that path anyway).
          // Parse Turtle and apply SPARQL Update directly
          const { Parser, Writer } = await import('n3');
          const parser = new Parser({ baseIRI: resourceUrl });
          let quads;
          try {
            quads = parser.parse(contentStr);
          } catch (parseErr) {
            return reply.code(409).send({
              error: 'Conflict',
              message: 'Resource is not valid Turtle: ' + parseErr.message
            });
          }

          // Parse the SPARQL Update
          const patchContent = Buffer.isBuffer(request.body) ? request.body.toString() : request.body;
          let update;
          try {
            update = parseSparqlUpdate(patchContent, resourceUrl);
          } catch (parseErr) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: 'Invalid SPARQL Update: ' + parseErr.message
            });
          }

          // Apply deletes
          for (const triple of update.deletes) {
            quads = quads.filter(q => {
              const matches = q.subject.value === triple.subject &&
                             q.predicate.value === triple.predicate &&
                             (q.object.value === (triple.object['@id'] || triple.object['@value'] || triple.object));
              return !matches;
            });
          }

          // Apply inserts
          const { DataFactory } = await import('n3');
          const { namedNode, literal } = DataFactory;
          for (const triple of update.inserts) {
            const subj = namedNode(triple.subject);
            const pred = namedNode(triple.predicate);
            let obj;
            if (triple.object['@id']) {
              obj = namedNode(triple.object['@id']);
            } else if (typeof triple.object === 'string') {
              obj = literal(triple.object);
            } else {
              obj = literal(triple.object['@value'] || triple.object);
            }
            quads.push(DataFactory.quad(subj, pred, obj));
          }

          // Serialize back to Turtle
          const writer = new Writer({ prefixes: {} });
          quads.forEach(q => writer.addQuad(q));
          let turtleOutput;
          writer.end((err, result) => { turtleOutput = result; });

          const success = await storage.write(storagePath, Buffer.from(turtleOutput));
          if (!success) {
            return reply.code(500).send({ error: 'Write failed' });
          }

          const origin = request.headers.origin;
          const headers = getAllHeaders({ isContainer: false, origin, resourceUrl });
          Object.entries(headers).forEach(([k, v]) => reply.header(k, v));

          if (request.notificationsEnabled) {
            emitChange(resourceUrl);
          }

          return reply.code(resourceExists ? 204 : 201).send();
        }

        return reply.code(409).send({
          error: 'Conflict',
          message: 'Resource is not valid JSON-LD and cannot be patched'
        });
      }
    }
  } else {
    // Create empty JSON-LD document for new resource
    document = {
      '@context': {},
      '@graph': []
    };
  }

  // Parse the patch
  const patchContent = Buffer.isBuffer(request.body)
    ? request.body.toString()
    : request.body;

  let updatedDocument;

  if (isMergePatch) {
    // P1 (LWS update-resource MUST, RFC 7386): merge-patch applies straight
    // to the stored JSON/JSON-LD document — no triple-level projection needed.
    let patchObj;
    try {
      patchObj = safeJsonParse(patchContent);
    } catch (e) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid JSON Merge Patch: ' + e.message
      });
    }
    updatedDocument = applyMergePatch(document, patchObj);
  } else if (isSparqlUpdate) {
    // Handle SPARQL Update
    let update;
    try {
      update = parseSparqlUpdate(patchContent, resourceUrl);
    } catch (e) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid SPARQL Update: ' + e.message
      });
    }

    try {
      updatedDocument = applySparqlUpdate(document, update, resourceUrl);
    } catch (e) {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'Failed to apply SPARQL Update: ' + e.message
      });
    }
  } else {
    // Handle N3 Patch
    let patch;
    try {
      patch = parseN3Patch(patchContent, resourceUrl);
    } catch (e) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Invalid N3 Patch format: ' + e.message
      });
    }

    // Task 8 (FLOOR, contract 2): the JSON-LD-document path does not bind a
    // solid:where — a full BGP evaluator over the projected node structure is
    // out of proportion for this arm (the Turtle-family/dataset path binds
    // where; store the resource as RDF to use it). The one outcome conformance
    // forbids is applying a conditional patch UNCONDITIONALLY, so a
    // where-carrying patch is rejected 409 rather than silently applied.
    if (patch.where && patch.where.length) {
      return reply.code(409).type('application/problem+json').send(JSON.stringify({
        type: 'about:blank', title: 'Conflict', status: 409,
        detail: 'conditional patch (solid:where) is not supported for this resource; store it as a Turtle-family RDF resource to use solid:where.',
        instance: resourceUrl,
      }, null, 2));
    }

    // Task 8 (contract 1): every delete triple MUST already exist —
    // validatePatch turns a delete of an absent triple into a 409, not a
    // silent no-op. Runs before applyN3Patch/the write, so nothing is stored
    // on rejection.
    const check = validatePatch(document, patch, resourceUrl);
    if (!check.valid) {
      return reply.code(409).type('application/problem+json').send(JSON.stringify({
        type: 'about:blank', title: 'Conflict', status: 409,
        detail: check.error, instance: resourceUrl,
      }, null, 2));
    }

    try {
      updatedDocument = applyN3Patch(document, patch, resourceUrl);
    } catch (e) {
      return reply.code(409).send({
        error: 'Conflict',
        message: 'Failed to apply patch: ' + e.message
      });
    }
  }

  // Write updated document.
  // task-6: split the two stored shapes — the pure-JSON-LD document rides the
  // shared write choke point (admission holds; .lwstypes/.lwsprov re-derive),
  // while an HTML data-island document stays a DIRECT write. The HTML case's
  // stored bytes are HTML, NOT a governed RDF source; routing them through
  // applyLwsWrite with contentType: application/ld+json would make the gate /
  // admission misread the HTML wrapper as a JSON-LD body.
  if (htmlWrapper) {
    // Re-embed JSON-LD into HTML wrapper — direct write (not RDF-governed).
    const jsonLdStr = JSON.stringify(updatedDocument, null, 2);
    const updatedContent = htmlWrapper.before + '\n' + jsonLdStr + '\n  ' + htmlWrapper.after;
    const success = await storage.write(storagePath, Buffer.from(updatedContent));
    if (!success) {
      return reply.code(500).send({ error: 'Write failed' });
    }
  } else {
    // Pure JSON-LD → applyLwsWrite. contentType is the resource's effective
    // type (application/ld+json by this point), NEVER the patch media type.
    // Under --lws-off, writeTypeConsistency returns ok and the admission block
    // is skipped, so the stored bytes are byte-identical to the prior direct
    // storage.write (verified by the --lws-off patch.test.js suite).
    const updatedContent = JSON.stringify(updatedDocument, null, 2);
    const w = await applyLwsWrite({
      storage, storagePath, resourceUrl,
      content: Buffer.from(updatedContent),
      contentType: RDF_TYPES.JSON_LD,
      declaredTypes: [],
      lwsEnabled: request.lwsEnabled,
    });
    if (!w.ok) {
      if (w.problem) {
        const r = reply.code(w.problem.status || 400).type('application/problem+json');
        if (w.problem.status === 405) r.header('Allow', 'GET, HEAD');
        return r.send(JSON.stringify(w.problem, null, 2));
      }
      reply.header('content-type', 'application/problem+json');
      if (w.shapeUrl) reply.header('Link', `<${w.shapeUrl}>; rel="describedby"`);
      return reply.code(400).send(constraintProblem({ shapeUrl: w.shapeUrl, violations: w.violations, instance: resourceUrl }));
    }
    if (!w.wrote) {
      return reply.code(500).send({ error: 'Write failed' });
    }
  }

  const origin = request.headers.origin;
  // Finding 3 (review round): align with patchTurtleFamilyResource's 204 —
  // pass lwsEnabled so a --lws pod's .jsonld PATCH 204 carries the same
  // LWS Link/Accept-Patch headers a .ttl PATCH 204 already does. Safe: every
  // lwsEnabled use in getAllHeaders/getResponseHeaders is a truthy check, so
  // this is byte-identical to the prior call when request.lwsEnabled is
  // false/undefined (the --lws-off case) — only the --lws-ON output gains
  // the headers it was already missing.
  const headers = getAllHeaders({ isContainer: false, origin, resourceUrl, lwsEnabled: request.lwsEnabled, storageRootPath: request.storageRootPath });
  Object.entries(headers).forEach(([k, v]) => reply.header(k, v));

  // Emit change notification for WebSocket subscribers
  if (request.notificationsEnabled) {
    emitChange(resourceUrl);
  }

  // Return 201 Created if resource was created, 204 No Content if updated
  return reply.code(resourceExists ? 204 : 201).send();
}
