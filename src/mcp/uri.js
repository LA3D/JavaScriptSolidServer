// src/mcp/uri.js
// The lws:// URI scheme for MCP Resources. Two shapes:
//   templated: lws://<kind>/<path>   kind ∈ resource|container|linkset|meta|acl|skill
//   fixed:     lws://<name>          name ∈ storage-description|pod-info|skills
// <path> is an LDP pod path and may contain '/' (RFC 6570 {+path} reserved
// expansion). parseUri maps a concrete URI back to { kind, path } | { fixed };
// an unknown scheme/kind/name → null (caller returns a not-found error).

export const PATH_KINDS = new Set(['resource', 'container', 'linkset', 'meta', 'acl', 'skill']);
export const FIXED_NAMES = new Set(['storage-description', 'pod-info', 'skills']);

const SCHEME = 'lws://';

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
  return { kind, path };
}

export function pathUri(kind, path) {
  const p = path.startsWith('/') ? path : '/' + path;
  return `${SCHEME}${kind}${p}`;
}

export function fixedUri(name) {
  return `${SCHEME}${name}`;
}
