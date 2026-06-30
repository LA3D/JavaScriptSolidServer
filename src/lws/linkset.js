const LWS = 'https://www.w3.org/ns/lws#';

/**
 * Generate an RFC 9264 linkset (application/linkset+json) for a resource.
 * Read-only discovery slice — mutation/concurrency (If-Match/412/428) deferred.
 * @param {string} resourceUrl
 * @param {{parentUrl?:string|null, isContainer:boolean, describedByUrl?:string}} opts
 * @returns {object}
 */
export function generateLinkset(resourceUrl, { parentUrl = null, isContainer = false, describedByUrl } = {}) {
  const link = { anchor: resourceUrl };
  if (parentUrl) link.up = [{ href: parentUrl }];
  link.type = [{ href: LWS + (isContainer ? 'Container' : 'DataResource') }];
  if (describedByUrl) link.describedby = [{ href: describedByUrl }];
  return { linkset: [link] };
}
