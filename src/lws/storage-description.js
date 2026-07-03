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
 * the HTTP GET /.well-known/lws-storage route and the MCP
 * `lws://storage-description` resource both call this so the advertised
 * service set can never drift between the two surfaces.
 * @param {string} origin  `${proto}://${host}` (no trailing slash)
 * @param {{typeIndexEnabled?:boolean, notificationsEnabled?:boolean}} flags
 * @returns {object}
 */
export function buildStorageDescription(origin, { typeIndexEnabled = false, notificationsEnabled = false } = {}) {
  const lwsStoragePath = '/.well-known/lws-storage';
  const services = [{ type: 'StorageDescription', serviceEndpoint: `${origin}${lwsStoragePath}` }];
  if (typeIndexEnabled) {
    services.push({ type: 'TypeIndexService', serviceEndpoint: `${origin}/types/index` });
    services.push({ type: 'TypeSearchService', serviceEndpoint: `${origin}/types/search` });
  }
  if (notificationsEnabled) {
    services.push({ type: 'NotificationService', serviceEndpoint: `${origin}/notification/api` });
  }
  return generateStorageDescription(`${origin}/`, services);
}
