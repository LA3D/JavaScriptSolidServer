// src/mcp/uri.js
// MCP Resources are addressed by the pod's REAL https:// URLs (LWS: a resource
// is identified by its URI; structure lives in rel-links/items, not a scheme).
// uriToPath maps a local resource URL back to its pod path; a foreign origin is
// a federation target, not a local read.

// A path is valid only if it survives decodeURIComponent — the storage layer
// decodes it later, so a malformed '%' here would otherwise throw URIError deep
// in the WAC/exists probe and surface as -32603 instead of invalid-params
// (review #4). Validate here, but keep the RAW path so storage decodes once.
function decodable(path) {
  try { decodeURIComponent(path); return true; }
  catch { return false; }
}

export function isLocalUri(origin, uri) {
  return typeof uri === 'string' && typeof origin === 'string' && uri.startsWith(origin + '/');
}

export function uriToPath(origin, uri) {
  if (!isLocalUri(origin, uri)) return null;
  const path = uri.slice(origin.length);          // keeps the leading '/'
  if (!path.startsWith('/') || !decodable(path)) return null;
  return path;
}
