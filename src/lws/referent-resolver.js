// Referent identity & discovery (2026-07-13): algorithmic 303 name->location.
// A minted name in a declared uriSpace maps to its backing container by a
// pathPrefix rewrite (httpRange-14; DBpedia /resource/ -> /data/ precedent).
// Pure; the caller applies no-oracle read-authz before emitting the 303.
//
// A uriSpace entry is { pathPrefix, container, suffix? }. The minted slug is
// content-derived and extensionless (e.g. subject IRI .../id/a#it for a card
// stored at <container>a.md), so an optional `suffix` names the canonical
// content file's extension appended to the slug (e.g. '.md' for wiki, absent
// when the stored file name equals the slug).
export function resolveReferent(urlPath, uriSpaces = []) {
  for (const { pathPrefix, container, suffix } of uriSpaces) {
    if (!pathPrefix || !container) continue;
    if (!pathPrefix.endsWith('/')) continue;         // footgun guard: '/id' would match '/identity'
    if (!urlPath.startsWith(pathPrefix)) continue;
    const slug = urlPath.slice(pathPrefix.length);
    if (!slug || slug.includes('/')) continue;               // flat namespace only
    const base = (container.endsWith('/') ? container : container + '/') + slug;
    return suffix ? base + suffix : base;                     // append the content-file suffix if declared
  }
  return null;
}
