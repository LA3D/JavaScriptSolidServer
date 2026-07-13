// Referent identity & discovery (2026-07-13): algorithmic 303 name->location.
// A minted name in a declared uriSpace maps to its backing container by a
// pathPrefix rewrite (httpRange-14; DBpedia /resource/ -> /data/ precedent).
// Pure; the caller applies no-oracle read-authz before emitting the 303.
export function resolveReferent(urlPath, uriSpaces = []) {
  for (const { pathPrefix, container } of uriSpaces) {
    if (!pathPrefix || !container) continue;
    if (!pathPrefix.endsWith('/')) continue;         // footgun guard: '/id' would match '/identity'
    if (!urlPath.startsWith(pathPrefix)) continue;
    const slug = urlPath.slice(pathPrefix.length);
    if (!slug || slug.includes('/')) continue;               // flat namespace only
    return (container.endsWith('/') ? container : container + '/') + slug;
  }
  return null;
}
