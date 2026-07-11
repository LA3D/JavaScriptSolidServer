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

// The bare origin (no trailing slash) is the root container's identity too
// (task-12) — recognized as local here so every isLocalUri call site (the
// read_resource tool's local-vs-remote gate, describe_resource, and the
// resources/read resolver) agrees without each needing its own patch.
export function isLocalUri(origin, uri) {
  return typeof uri === 'string' && typeof origin === 'string' &&
    (uri === origin || uri.startsWith(origin + '/'));
}

export function uriToPath(origin, uri) {
  if (!isLocalUri(origin, uri)) return null;
  if (uri === origin) return '/';
  const path = uri.slice(origin.length);          // keeps the leading '/'
  if (!path.startsWith('/') || !decodable(path)) return null;
  return path;
}
