// src/mcp/surface.js
// The single declarative registry for the MCP Resources surface. One entry per
// lws:// surface; the parse set (uri.js), the dispatch map + advertisement
// (resources.js) all DERIVE from these arrays, so adding a surface is one entry
// here + one resolver binding — never three hand-synced tables (review #11).

// Templated, path-addressed resources: lws://<kind>/<path>.
export const SURFACE_TEMPLATES = [
  { kind: 'resource', description: 'A resource body (any content type), enveloped as untrusted data.', mimeType: 'text/plain' },
  { kind: 'container', description: 'A container listing (ldp:contains children).', mimeType: 'application/json' },
  { kind: 'linkset', description: 'RFC 9264 linkset: anchor/up/type/describedby.', mimeType: 'application/linkset+json' },
  { kind: 'meta', description: 'Resource metadata (size/modified).', mimeType: 'application/json' },
  { kind: 'acl', description: 'Structured ACL (requires acl:Control).', mimeType: 'application/json' },
  { kind: 'skill', description: 'A skill file body.', mimeType: 'application/json' },
];

// Fixed, singleton resources: lws://<name>.
export const SURFACE_FIXED = [
  { name: 'storage-description', description: 'The LWS storage description (type:Storage + services).', mimeType: 'application/json' },
  { name: 'pod-info', description: 'Pod identity + MCP capabilities.', mimeType: 'application/json' },
  { name: 'skills', description: 'Skill index (WAC-filtered, no-oracle).', mimeType: 'application/json' },
];

export const PATH_KINDS = new Set(SURFACE_TEMPLATES.map(t => t.kind));
export const FIXED_NAMES = new Set(SURFACE_FIXED.map(f => f.name));
