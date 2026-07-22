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
 * Resolve the pod-config-derived inputs to buildStorageDescriptionFor's
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
 * McpService entry — one gateway per pod, not per storage, so both
 * `assembleDescription` (per-storage/root-pod description) and
 * `buildServerIndex` (the cross-storage roster) share this single builder
 * rather than duplicating the hint + budget-sentence text (services round).
 * @param {string} origin
 * @param {number|null} anonRateLimitMax
 * @returns {object}
 */
function mcpServiceEntry(origin, anonRateLimitMax) {
  // Budget sentence appended when the caller threads the configured
  // anonymous rate-limit cap through (server.js's anonRateLimitMax) — a
  // cold agent hitting 429s otherwise has no way to learn the budget is
  // per-IP-anonymous, not a pod-wide outage (probe #7 batch).
  const budgetHint = anonRateLimitMax != null
    ? ` Anonymous callers: ${anonRateLimitMax} requests/minute — authenticate for more; the x-ratelimit headers carry your remaining budget.`
    : '';
  return {
    type: 'McpService',
    serviceEndpoint: `${origin}/mcp`,
    // Steering (unmapped, like the linkset hint): the endpoint 405s GETs,
    // so a cold agent needs told HOW to speak to it.
    hint: 'Model Context Protocol gateway — JSON-RPC 2.0 over Streamable HTTP: POST initialize to this endpoint, then notifications/initialized; the read loop is the read_resource/list_resources tools.' + budgetHint,
  };
}

/**
 * Shared service-list + capability + linkset assembly for
 * `buildStorageDescriptionFor`, the sole description builder.
 * TypeIndexService/TypeSearchService are STORAGE-scoped (services round,
 * R7): derived from `idUrl` itself, so they land at `/alice/types/index`
 * for a per-storage `idUrl` and stay origin-identical (`/types/index`) for
 * the root-pod `/` form — either way the endpoint exists (Task 6's routes
 * mirror this derivation). VoidService is a direct pointer composed off
 * `origin` (voidPath is itself absolute-from-origin, same convention as
 * profileIndexPath — see below). McpService stays ORIGIN-scoped on purpose:
 * MCP is one gateway per pod, not per storage.
 * @param {string} idUrl  the description's own `id` (trailing slash)
 * @param {string} sdEndpoint  this description's own serviceEndpoint
 * @param {{typeIndexEnabled?:boolean, profileIndexPath?:string|null, voidPath?:string|null, profileConnegEnabled?:boolean, referentResolutionEnabled?:boolean, uriSpacePrefixes?:string[], mcpEnabled?:boolean, anonRateLimitMax?:number|null, owners?:string[], provider?:string|null}} flags
 * @returns {object}
 */
function assembleDescription(idUrl, sdEndpoint, { typeIndexEnabled = false, profileIndexPath = null, voidPath = null, profileConnegEnabled = false, referentResolutionEnabled = false, uriSpacePrefixes = [], mcpEnabled = false, anonRateLimitMax = null, owners = [], provider = null } = {}) {
  const origin = new URL(idUrl).origin;
  const services = [{ type: 'StorageDescription', serviceEndpoint: sdEndpoint }];
  if (typeIndexEnabled) {
    // Storage-scoped (services round, R7): derived from idUrl, not origin —
    // idUrl always ends with '/', so this is per-storage for '/alice/' and
    // origin-identical for the root-pod '/' form (no dead endpoint either way).
    services.push({ type: 'TypeIndexService', serviceEndpoint: `${idUrl}types/index` });
    services.push({
      type: 'TypeSearchService',
      serviceEndpoint: `${idUrl}types/search`,
      // Steering (unmapped, like the McpService/linkset hints): verified 2026-07-11
      // against src/handlers/type-index.js handleTypeSearch + src/lws/type-index.js
      // parseFilter/matchesTypeFilter — `type` is the CNF filter param (comma =
      // OR within a group, repeated param = AND across groups); `describedby`
      // and `conformsTo` are the other two indexed relations, same CNF syntax.
      hint: 'GET with ?type=<uri> returns instances of that type; comma-separate values in one param for OR, repeat the parameter for AND. A bare GET returns the full inventory. The same CNF syntax also filters by indexed relations: ?describedby=<uri> and ?conformsTo=<uri>.',
    });
  }
  if (profileIndexPath) {
    services.push({ type: 'ProfileIndexService', serviceEndpoint: `${origin}${profileIndexPath}` });
  }
  if (voidPath) {
    services.push({ type: 'VoidService', serviceEndpoint: `${origin}${voidPath}`,
      // Direct pointer to the pod-served VoID document (services round): the
      // SD is generated from the same per-storage pod-config at request
      // time, so a 303 indirection here buys nothing. The origin
      // /.well-known/void 303 stays as the legacy/root rail.
      hint: 'VoID description of the datasets this storage serves — the vocabularies in use (each with a pod-served copy), root resources, and the subject URI space.' });
  }
  // MCP is one gateway per pod, not per storage — always the origin.
  if (mcpEnabled) services.push(mcpServiceEntry(origin, anonRateLimitMax));
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
      hint: 'This storage negotiates representations by profile (a subset of W3C Content Negotiation by Profile): matching is by EXACT profile URI — token forms and isProfileOf hierarchy walking are not supported. Send Accept-Profile: <profile-uri> using a URI this resource declares; the complete set is enumerated in its linkset (Accept: application/linkset+json — canonical/alternate links with type=media, formats=profile) and repeated by any profile 406. When several representations share the requested profile, the Accept media type picks among them; ties go to the default representation, then declaration order.',
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
  // Governance (2026-07-22): owner = solid:owner (the storage's .lwsowner
  // record, READ-gated by the serving route); provider = schema:provider
  // (deployment operator, config-only — root-pod description + ServerIndex,
  // never per-tenant). LWS Discovery: "Additional properties MAY be present."
  if (owners.length) doc.owner = owners;
  if (provider) doc.provider = provider;
  if (capability.length > 0) doc.capability = capability;
  return doc;
}

/**
 * Build the full LWS Storage Description document for a SINGLE STORAGE ROOT
 * inside a multi-tenant pod (`id` = the storage root itself, StorageDescription
 * self-pointer at `${base}/lws-storage` instead of the origin well-known
 * path). Services are storage-scoped by construction (see assembleDescription):
 * TypeIndexService/TypeSearchService/VoidService derive from the caller's
 * `storageRootUrl`/`voidPath`, ProfileIndexService and the uriSpace
 * capability were already per-storage. McpService is the one deliberate
 * exception (one gateway per pod). Recorded limitation (spec §5): a
 * storage's `voidPath` and the origin-level `/.well-known/void` 303 rail are
 * two independent config reads (per-storage vs. legacy server-wide
 * podConfig) — a mixed-mode deployment naming different targets in each is
 * not reconciled here.
 * @param {string} storageRootUrl  absolute, trailing slash, e.g. 'http://h/alice/'
 * @param {{typeIndexEnabled?:boolean, profileIndexPath?:string|null, voidPath?:string|null, profileConnegEnabled?:boolean, referentResolutionEnabled?:boolean, uriSpacePrefixes?:string[], mcpEnabled?:boolean, anonRateLimitMax?:number|null, owners?:string[], provider?:string|null}} flags
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
 * @param {{typeIndexEnabled?:boolean, mcpEnabled?:boolean, anonRateLimitMax?:number|null, provider?:string|null}} flags
 * @returns {object}
 */
export function buildServerIndex(origin, storages = [], { typeIndexEnabled = false, mcpEnabled = false, anonRateLimitMax = null, provider = null } = {}) {
  const idx = {
    '@context': LWS_CONTEXT,
    id: `${origin}/`,
    type: 'ServerIndex',
    storage: storages.map(s => ({
      id: `${origin}${s.root}`,
      storageDescription: `${origin}${s.root}lws-storage`,
    })),
  };
  if (provider) idx.provider = provider;
  // Extension surface (ServerIndex is itself a JSS extension): the
  // cross-storage aggregates live here, NOT in per-storage descriptions —
  // each storage advertises only its own scoped services (R7).
  const service = [];
  if (typeIndexEnabled) {
    service.push({ type: 'TypeIndexService', serviceEndpoint: `${origin}/types/index`,
      hint: 'Cross-storage inventory: distinct resource types across ALL storages on this server, filtered to what you are authorized to read. Each storage advertises its own storage-scoped index in its storage description.' });
    service.push({ type: 'TypeSearchService', serviceEndpoint: `${origin}/types/search`,
      hint: 'Cross-storage search over ALL storages on this server (authorization-filtered). GET with ?type=<uri>; comma-separate values in one param for OR, repeat the parameter for AND; ?describedby=<uri> and ?conformsTo=<uri> filter by indexed relations. Each storage advertises its own storage-scoped search in its storage description.' });
  }
  if (mcpEnabled) service.push(mcpServiceEntry(origin, anonRateLimitMax));
  if (service.length) idx.service = service;
  return idx;
}
