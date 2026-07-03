// src/mcp/surface.js
// The declarative registry for the MCP Resources surface. Resources are
// addressed by the pod's REAL https:// URLs (LWS: a resource is identified by
// its URI; structure lives in rel-links/items, not a synthetic scheme). The
// fixed .well-known resources are advertised here; everything else is one
// template — dispatch happens on the resource itself (resources.js).

export const FIXED_SUFFIXES = [
  { suffix: '/.well-known/lws-storage', name: 'storage-description', description: 'START HERE — the LWS storage description: services, vocab locations, storage root.', mimeType: 'application/lws+json' },
  { suffix: '/.well-known/mcp/pod-info', name: 'pod-info', description: 'Pod identity + MCP capabilities + where the vocabulary lives.', mimeType: 'application/json' },
  { suffix: '/.well-known/mcp/skills', name: 'skills', description: 'Skill index (WAC-filtered).', mimeType: 'application/json' },
  { suffix: '/.well-known/lws/context', name: 'lws-context', description: 'The LWS JSON-LD @context (resolvable mirror of www.w3.org/ns/lws/v1).', mimeType: 'application/ld+json' },
  { suffix: '/.well-known/lws/vocab', name: 'lws-vocab', description: 'The LWS system vocabulary (term meanings).', mimeType: 'application/ld+json' },
];

export function listFixed(origin) {
  return FIXED_SUFFIXES.map(f => ({ uri: `${origin}${f.suffix}`, name: f.name, description: f.description, mimeType: f.mimeType }));
}

export const RESOURCE_TEMPLATE = {
  uriTemplate: 'https://{+authority}/{+path}',
  name: 'resource',
  description: 'Any pod resource, addressed by its real https:// URL. Read it, then follow the typed links (rel="up", describedby, and edges in the body) and consult its @context.',
  mimeType: 'application/ld+json',
};
