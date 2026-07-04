const LWS = 'https://www.w3.org/ns/lws#';
const DCT_CONFORMS = 'http://purl.org/dc/terms/conformsTo';

/**
 * Generate an RFC 9264 linkset (application/linkset+json) for a resource.
 * Read-only discovery slice — mutation/concurrency (If-Match/412/428) deferred.
 * `describedby` carries the resource's declared SHACL shape target(s);
 * `http://purl.org/dc/terms/conformsTo` (full URI — extension relation per
 * RFC 8288 §2.1.2) carries the declared profile descriptor(s). Each omitted
 * entirely when not declared.
 * @param {string} resourceUrl
 * @param {{parentUrl?:string|null, isContainer:boolean, describedByShapes?:string[], declaredTypes?:string[], conformsTo?:string[]}} opts
 * @returns {object}
 */
export function generateLinkset(resourceUrl, { parentUrl = null, isContainer = false, describedByShapes = [], declaredTypes = [], conformsTo = [] } = {}) {
  const link = { anchor: resourceUrl };
  if (parentUrl) link.up = [{ href: parentUrl }];
  const types = [LWS + (isContainer ? 'Container' : 'DataResource')];
  for (const t of declaredTypes) if (!types.includes(t)) types.push(t);
  link.type = types.map((href) => ({ href }));
  if (describedByShapes.length) link.describedby = describedByShapes.map((href) => ({ href }));
  if (conformsTo.length) link[DCT_CONFORMS] = conformsTo.map((href) => ({ href }));
  return { linkset: [link] };
}
