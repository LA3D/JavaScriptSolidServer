// src/mcp/uri.js
// The lws:// URI scheme for MCP Resources. Two shapes:
//   templated: lws://<kind>/<path>   kind ∈ resource|container|linkset|meta|acl|skill
//   fixed:     lws://<name>          name ∈ storage-description|pod-info|skills
// The valid kind/name sets come from the single surface registry (surface.js).
// <path> is an LDP pod path and may contain '/' (RFC 6570 {+path} reserved
// expansion). parseUri maps a concrete URI back to { kind, path } | { fixed };
// an unknown scheme/kind/name OR a malformed percent-sequence → null (caller
// returns a not-found / invalid-params error, never a raw URIError).

import { PATH_KINDS, FIXED_NAMES } from './surface.js';

export { PATH_KINDS, FIXED_NAMES };

const SCHEME = 'lws://';

// A path is valid only if it survives decodeURIComponent — the storage layer
// decodes it later, so a malformed '%' here would otherwise throw URIError deep
// in the WAC/exists probe and surface as -32603 instead of invalid-params
// (review #4). Validate here, but keep the RAW path so storage decodes once.
function decodable(path) {
  try { decodeURIComponent(path); return true; }
  catch { return false; }
}

export function parseUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(SCHEME)) return null;
  const rest = uri.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash === -1) {
    return FIXED_NAMES.has(rest) ? { fixed: rest } : null;
  }
  const kind = rest.slice(0, slash);
  if (!PATH_KINDS.has(kind)) return null;
  let path = rest.slice(slash);          // includes the leading '/'
  if (!path.startsWith('/')) path = '/' + path;
  if (!decodable(path)) return null;
  return { kind, path };
}

export function pathUri(kind, path) {
  const p = path.startsWith('/') ? path : '/' + path;
  return `${SCHEME}${kind}${p}`;
}

export function fixedUri(name) {
  return `${SCHEME}${name}`;
}
