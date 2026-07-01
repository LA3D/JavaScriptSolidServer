const LWS = 'https://www.w3.org/ns/lws#';

/**
 * Generate an RFC 9264 linkset (application/linkset+json) for a resource.
 * Read-only discovery slice — mutation/concurrency (If-Match/412/428) deferred.
 * `describedby` carries the resource's declared SHACL shape target(s) (LWS
 * core: linkset describedby → schema); omitted entirely when none are declared.
 * @param {string} resourceUrl
 * @param {{parentUrl?:string|null, isContainer:boolean, describedByShapes?:string[], declaredTypes?:string[]}} opts
 * @returns {object}
 */
export function generateLinkset(resourceUrl, { parentUrl = null, isContainer = false, describedByShapes = [], declaredTypes = [] } = {}) {
  const link = { anchor: resourceUrl };
  if (parentUrl) link.up = [{ href: parentUrl }];
  const types = [LWS + (isContainer ? 'Container' : 'DataResource')];
  for (const t of declaredTypes) if (!types.includes(t)) types.push(t);
  link.type = types.map((href) => ({ href }));
  if (describedByShapes.length) link.describedby = describedByShapes.map((href) => ({ href }));
  return { linkset: [link] };
}
