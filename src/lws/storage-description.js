import { prefersPlainJson } from '../rdf/conneg.js';
import { uriSpacePrefixesFor } from './referent-resolver.js';

const LWS_CONTEXT = 'https://www.w3.org/ns/lws/v1';

/**
 * Derive the storage description URL from any resource URL in that storage.
 * With no `storageRootPath`, the server-index/legacy single-storage form:
 * {origin}/.well-known/lws-storage. When a per-storage root path is given
 * (e.g. '/alice/'), the per-storage form: {origin}{storageRootPath}lws-storage.
 * @param {string} resourceUrl
 * @param {string|null} [storageRootPath]
 * @returns {string}
 */
export function storageDescriptionUrl(resourceUrl, storageRootPath = null) {
  if (!resourceUrl || !resourceUrl.includes('://')) throw new Error(`storageDescriptionUrl requires an absolute URL, got: ${resourceUrl}`);
  const origin = new URL(resourceUrl).origin;
  return storageRootPath ? `${origin}${storageRootPath}lws-storage` : `${origin}/.well-known/lws-storage`;
}

// P3 (LWS media-type MUST, FOLLOWUP.md conformance-audit 2026-07-12): the
// storage description body never changes — only which of the three
// equivalent JSON media-type spellings labels it. application/lws+json is
// this resource's own registered type (IANA-Considerations.html) and stays
// the default (absent/generic Accept, or whenever explicitly present —
// mirrors selectContentType's unconditional lws+json early-return in
// resource.js). An explicit application/ld+json or application/json Accept
// (and no lws+json) relabels to what was asked for; prefersPlainJson gives
// the q-aware json-vs-ld+json ranking, same rule the container-listing
// label swap uses.
export function storageDescriptionContentType(acceptHeader) {
  if (!acceptHeader) return 'application/lws+json';
  const header = acceptHeader.toLowerCase();
  if (header.includes('application/lws+json')) return 'application/lws+json';
  if (prefersPlainJson(acceptHeader)) return 'application/json';
  if (header.includes('application/ld+json')) return 'application/ld+json';
  return 'application/lws+json';
}

/**
 * Generate the W3C LWS Storage Description resource (application/lws+json).
 * Spec: Discovery.html — @context/id/type/service all REQUIRED; each service
 * MUST carry type + serviceEndpoint. Single-storage; multi-pod deferred.
 * @param {string} storageRootUrl  the storage's URI (the `id`)
 * @param {Array<{type:string, serviceEndpoint:string}>} services
 * @returns {object}
 */
export function generateStorageDescription(storageRootUrl, services = []) {
  return {
    '@context': LWS_CONTEXT,
    id: storageRootUrl,
    type: 'Storage',
    service: services,
  };
}

/**
 * Resolve the pod-config-derived inputs to buildStorageDescription's
 * referent-resolution capability (Task 7, spec 2026-07-15): reads
 * profileIndex/void/uriSpaces off the decorated podConfig and derives
 * referentResolutionEnabled + its uriSpacePrefixes via the SAME
 * uriSpacePrefixesFor the MCP surface uses. Factored out so the
 * /.well-known/lws-storage HTTP route (src/server.js) and the navigator
 * root/storage view (src/handlers/resource.js) can't drift on what they
 * derive from the SAME uriSpaces config — one call site, not two copies of
 * the same five lines.
 * @param {{get: () => Promise<object>}} podConfig
 * @param {string} origin
 * @param {boolean} lwsEnabled
 */
export async function resolveStorageDescriptionInputs(podConfig, origin, lwsEnabled) {
  const { profileIndex, void: voidPath, uriSpaces } = await podConfig.get();
  const referentResolutionEnabled = lwsEnabled && Array.isArray(uriSpaces) && uriSpaces.length > 0;
  const uriSpacePrefixes = referentResolutionEnabled ? uriSpacePrefixesFor(uriSpaces, origin) : [];
  return { profileIndexPath: profileIndex, voidPath, referentResolutionEnabled, uriSpacePrefixes };
}

/**
 * Shared service-list + capability + linkset assembly for both the
 * single-origin (`buildStorageDescription`) and per-storage
 * (`buildStorageDescriptionFor`) description builders. This multi-tenant
 * round adds NO per-storage service ROUTES — only server-wide routes exist
 * (/types/index, /types/search, /.well-known/void, /notification/api,
 * /mcp) — so every service endpoint below is ORIGIN-scoped (derived from
 * `idUrl`'s origin), matching whatever `buildStorageDescription` (the
 * pre-multi-tenant origin form) already emitted. The two builders differ
 * only in `idUrl` (the description's own `id`) and `sdEndpoint` (this
 * description's OWN StorageDescription self-pointer — per-storage for
 * `buildStorageDescriptionFor`, origin-well-known for `buildStorageDescription`).
 * profileIndexPath is itself an absolute-from-origin path (e.g.
 * `/alice/profiles/index.jsonld`, per pod-config.js), so composing it
 * against origin (not a storage-scoped base) already lands per-storage
 * without a second `/alice/` prefix.
 * @param {string} idUrl  the description's own `id` (trailing slash)
 * @param {string} sdEndpoint  this description's own serviceEndpoint
 * @param {{typeIndexEnabled?:boolean, notificationsEnabled?:boolean, profileIndexPath?:string|null, voidPath?:string|null, profileConnegEnabled?:boolean, referentResolutionEnabled?:boolean, uriSpacePrefixes?:string[], mcpEnabled?:boolean, anonRateLimitMax?:number|null}} flags
 * @returns {object}
 */
function assembleDescription(idUrl, sdEndpoint, { typeIndexEnabled = false, notificationsEnabled = false, profileIndexPath = null, voidPath = null, profileConnegEnabled = false, referentResolutionEnabled = false, uriSpacePrefixes = [], mcpEnabled = false, anonRateLimitMax = null } = {}) {
  const origin = new URL(idUrl).origin;
  const services = [{ type: 'StorageDescription', serviceEndpoint: sdEndpoint }];
  if (typeIndexEnabled) {
    services.push({ type: 'TypeIndexService', serviceEndpoint: `${origin}/types/index` });
    services.push({
      type: 'TypeSearchService',
      serviceEndpoint: `${origin}/types/search`,
      // Steering (unmapped, like the McpService/linkset hints): verified 2026-07-11
      // against src/handlers/type-index.js handleTypeSearch + src/lws/type-index.js
      // parseFilter/matchesTypeFilter — `type` is the CNF filter param (comma =
      // OR within a group, repeated param = AND across groups); `describedby`
      // and `conformsTo` are the other two indexed relations, same CNF syntax.
      hint: 'GET with ?type=<uri> returns instances of that type; comma-separate values in one param for OR, repeat the parameter for AND. A bare GET returns the full inventory. The same CNF syntax also filters by indexed relations: ?describedby=<uri> and ?conformsTo=<uri>.',
    });
  }
  if (notificationsEnabled) {
    services.push({ type: 'NotificationService', serviceEndpoint: `${origin}/notification/api` });
  }
  if (profileIndexPath) {
    services.push({ type: 'ProfileIndexService', serviceEndpoint: `${origin}${profileIndexPath}` });
  }
  if (voidPath) {
    services.push({ type: 'VoidService', serviceEndpoint: `${origin}/.well-known/void`,
      // Steering (unmapped, like the TypeSearchService/McpService hints):
      // the endpoint is a 303, so a cold agent needs told what's behind it.
      hint: 'VoID description of the datasets this storage serves — the vocabularies in use (each with a pod-served copy), root resources, and the subject URI space. GET follows a 303 to the description document.' });
  }
  if (mcpEnabled) {
    // MCP is one gateway per pod, not per storage — always the origin.
    // Budget sentence appended when the caller threads the configured
    // anonymous rate-limit cap through (server.js's anonRateLimitMax) — a
    // cold agent hitting 429s otherwise has no way to learn the budget is
    // per-IP-anonymous, not a pod-wide outage (probe #7 batch).
    const budgetHint = anonRateLimitMax != null
      ? ` Anonymous callers: ${anonRateLimitMax} requests/minute — authenticate for more; the x-ratelimit headers carry your remaining budget.`
      : '';
    services.push({
      type: 'McpService',
      serviceEndpoint: `${origin}/mcp`,
      // Steering (unmapped, like the linkset hint): the endpoint 405s GETs,
      // so a cold agent needs told HOW to speak to it.
      hint: 'Model Context Protocol gateway — JSON-RPC 2.0 over Streamable HTTP: POST initialize to this endpoint, then notifications/initialized; the read loop is the read_resource/list_resources tools.' + budgetHint,
    });
  }
  const doc = {
    ...generateStorageDescription(idUrl, services),
    // Steering, not spec vocabulary (unmapped in the LWS @context — the
    // audience is a cold LLM agent reading JSON): RFC-9264-as-storage-metadata
    // is LWS-new and outside model priors; the priming ablation (2026-07-04)
    // showed one sentence naming the RFC flips agent behavior.
    linkset: {
      mediaType: 'application/linkset+json',
      conformsTo: 'https://www.rfc-editor.org/rfc/rfc9264',
      // Wording is load-bearing: an unprimed cold agent inferred (2026-07-06
      // probe) that members carry describedby/conformsTo — they live on the
      // CONTAINER linkset; a member's affordance for them is its `up` edge.
      // Reworded 2026-07-10 (probe #4b/#5): the old "every resource" over-promised
      // on shadowed containers, and a linkset-only client concluded containers were empty
      // — membership steering added.
      // Reworded 2026-07-11 (spec §4, A3): Task 5 made the shadowed-container
      // escape TRUE (a specific non-HTML Accept, including on the root, now
      // reaches the real listing) — "descend to a member" was no longer the
      // only escape and had gone stale; teach the conneg escape instead.
      hint: 'This storage speaks RFC 9264: resources serve a linkset of their typed links — request the resource URL with Accept: application/linkset+json (rel="linkset"); a container shadowed by its index.html serves the HTML only to HTML-accepting requests — request it with a specific non-HTML Accept (application/lws+json, text/turtle, application/linkset+json) for the real container view; this includes the root: GET / with Accept: application/lws+json lists the top-level containers. A member linkset carries up/type; the governing describedby (SHACL shape) and conformsTo (profile) edges live on its CONTAINER\'s linkset — follow up. Linksets carry governance, not membership: list members by GETting the container itself (ldp:contains, or items[] via Accept: application/lws+json); search by type via the TypeSearchService.',
    },
  };
  // Capability array is hoisted out of the conneg-only gate so a second,
  // independent capability (referent resolution) can coexist — only
  // attached to `doc` if non-empty, so the default (neither flag set)
  // stays byte-identical to before this array existed (no `capability` key).
  const capability = [];
  if (profileConnegEnabled) {
    capability.push({
      // DX-PROF-CONNEG cnpr:http functional profile — the pod negotiates
      // representations by profile via Accept-Profile / Content-Profile.
      type: 'http://www.w3.org/ns/dx/connegp/profile/http',
      hint: 'This storage negotiates by profile (W3C Content Negotiation by Profile). Send Accept-Profile: <profile-uri> to select a representation; a resource lists its representations as canonical/alternate links in its RFC 9264 linkset (type=media, formats=profile).',
    });
  }
  if (referentResolutionEnabled) {
    const cap = {
      // Parallel to DX-PROF-CONNEG above: this storage resolves minted
      // subject-IRI names (a declared void:uriSpace) by 303 redirect.
      type: 'https://w3id.org/lws-pod/capability/ReferentResolution',
      hint: 'This storage dereferences minted subject-IRI names by 303 redirect to their backing resource. A name under one of the uriSpace prefixes below resolves via GET; the referent is the #it fragment. Discover typed referents via the Type Search service.',
    };
    // Recognition prefixes (steering, unmapped like the sibling hints): the
    // void:uriSpace values, so a cold agent recognizes a minted IRI on its
    // FIRST read of the storage description instead of confirming the prefix
    // from the VoID document two hops later (probe #2). Prefixes only — the
    // container/suffix mapping stays internal; the 303 is the resolver.
    if (uriSpacePrefixes.length) cap.uriSpace = uriSpacePrefixes;
    capability.push(cap);
  }
  if (capability.length > 0) doc.capability = capability;
  return doc;
}

/**
 * Build the full LWS Storage Description document for an origin, given
 * which optional services are enabled. Single source of the service list —
 * the HTTP GET /.well-known/lws-storage route and the MCP storage-description
 * resource (read at /.well-known/lws-storage) both call this so the advertised
 * service set can never drift between the two surfaces.
 *
 * This is the ORIGIN-scoped form (id = `${origin}/`, single well-known
 * endpoint) — pre-multi-tenant callers (server.js, mcp/resources.js,
 * handlers/resource.js) all still call this. See `buildStorageDescriptionFor`
 * for the per-storage-root form used by multi-tenant pods.
 * @param {string} origin  `${proto}://${host}` (no trailing slash)
 * @param {{typeIndexEnabled?:boolean, notificationsEnabled?:boolean, profileIndexPath?:string|null, voidPath?:string|null, profileConnegEnabled?:boolean, referentResolutionEnabled?:boolean, uriSpacePrefixes?:string[], mcpEnabled?:boolean, anonRateLimitMax?:number|null}} flags
 * @returns {object}
 */
export function buildStorageDescription(origin, flags = {}) {
  return assembleDescription(`${origin}/`, `${origin}/.well-known/lws-storage`, flags);
}

/**
 * Build the full LWS Storage Description document for a SINGLE STORAGE ROOT
 * inside a multi-tenant pod (`id` = the storage root itself, StorageDescription
 * self-pointer at `${base}/lws-storage` instead of the origin well-known
 * path). Every OTHER service (TypeIndexService, TypeSearchService,
 * VoidService, NotificationService, McpService) stays origin-scoped — this
 * round adds no per-storage service routes, so advertising e.g.
 * `/alice/types/index` would be a dead endpoint. ProfileIndexService and the
 * uriSpace capability are the two genuinely per-storage pieces (the former
 * because profileIndexPath is itself an absolute-from-origin path baked at
 * publish time, the latter because the caller passes storage-scoped prefixes).
 * @param {string} storageRootUrl  absolute, trailing slash, e.g. 'http://h/alice/'
 * @param {{typeIndexEnabled?:boolean, notificationsEnabled?:boolean, profileIndexPath?:string|null, voidPath?:string|null, profileConnegEnabled?:boolean, referentResolutionEnabled?:boolean, uriSpacePrefixes?:string[], mcpEnabled?:boolean, anonRateLimitMax?:number|null}} flags
 * @returns {object}
 */
export function buildStorageDescriptionFor(storageRootUrl, flags = {}) {
  const base = storageRootUrl.replace(/\/$/, '');
  return assembleDescription(storageRootUrl, `${base}/lws-storage`, flags);
}

/**
 * Build a Server Index document — the multi-tenant root resource listing
 * every storage the pod hosts, each pointing at its own per-storage
 * description (`buildStorageDescriptionFor`'s `id`). Deliberately typed
 * `ServerIndex`, not `Storage` — a server index is a list of storages, not
 * a storage itself.
 * @param {string} origin  `${proto}://${host}` (no trailing slash)
 * @param {Array<{root:string}>} storages  e.g. [{ root: '/alice/' }]
 * @returns {object}
 */
export function buildServerIndex(origin, storages = []) {
  return {
    '@context': LWS_CONTEXT,
    id: `${origin}/`,
    type: 'ServerIndex',
    storage: storages.map(s => ({
      id: `${origin}${s.root}`,
      storageDescription: `${origin}${s.root}lws-storage`,
    })),
  };
}
