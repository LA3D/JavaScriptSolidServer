const LWS_CONTEXT = 'https://www.w3.org/ns/lws/v1';

/**
 * Derive the storage description URL from any resource URL in that storage.
 * Single-storage assumption (L2): always {origin}/.well-known/lws-storage.
 * @param {string} resourceUrl
 * @returns {string}
 */
export function storageDescriptionUrl(resourceUrl) {
  if (!resourceUrl || !resourceUrl.includes('://')) throw new Error(`storageDescriptionUrl requires an absolute URL, got: ${resourceUrl}`);
  return `${new URL(resourceUrl).origin}/.well-known/lws-storage`;
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
 * Build the full LWS Storage Description document for an origin, given
 * which optional services are enabled. Single source of the service list —
 * the HTTP GET /.well-known/lws-storage route and the MCP storage-description
 * resource (read at /.well-known/lws-storage) both call this so the advertised
 * service set can never drift between the two surfaces.
 * @param {string} origin  `${proto}://${host}` (no trailing slash)
 * @param {{typeIndexEnabled?:boolean, notificationsEnabled?:boolean, profileIndexPath?:string|null, profileConnegEnabled?:boolean}} flags
 * @returns {object}
 */
export function buildStorageDescription(origin, { typeIndexEnabled = false, notificationsEnabled = false, profileIndexPath = null, profileConnegEnabled = false } = {}) {
  const lwsStoragePath = '/.well-known/lws-storage';
  const services = [{ type: 'StorageDescription', serviceEndpoint: `${origin}${lwsStoragePath}` }];
  if (typeIndexEnabled) {
    services.push({ type: 'TypeIndexService', serviceEndpoint: `${origin}/types/index` });
    services.push({ type: 'TypeSearchService', serviceEndpoint: `${origin}/types/search` });
  }
  if (notificationsEnabled) {
    services.push({ type: 'NotificationService', serviceEndpoint: `${origin}/notification/api` });
  }
  if (profileIndexPath) {
    services.push({ type: 'ProfileIndexService', serviceEndpoint: `${origin}${profileIndexPath}` });
  }
  const base = {
    ...generateStorageDescription(`${origin}/`, services),
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
      hint: 'This storage speaks RFC 9264: resources serve a linkset of their typed links — request the resource URL with Accept: application/linkset+json (rel="linkset"); a container shadowed by its index.html serves the HTML instead, so descend to a member. A member linkset carries up/type; the governing describedby (SHACL shape) and conformsTo (profile) edges live on its CONTAINER\'s linkset — follow up. Linksets carry governance, not membership: list members by GETting the container itself (ldp:contains, or items[] via Accept: application/lws+json); search by type via the TypeSearchService.',
    },
  };
  if (profileConnegEnabled) {
    base.capability = [{
      // DX-PROF-CONNEG cnpr:http functional profile — the pod negotiates
      // representations by profile via Accept-Profile / Content-Profile.
      type: 'http://www.w3.org/ns/dx/connegp/profile/http',
      hint: 'This storage negotiates by profile (W3C Content Negotiation by Profile). Send Accept-Profile: <profile-uri> to select a representation; a resource lists its representations as canonical/alternate links in its RFC 9264 linkset (type=media, formats=profile).',
    }];
  }
  return base;
}
