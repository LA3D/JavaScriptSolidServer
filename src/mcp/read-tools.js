// src/mcp/read-tools.js
// The model-driven read/nav path (spec 2026-07-06-mcp-model-driven-read).
// MCP Resources are application-driven (host-staged) per MCP 2025-03-26, so
// an autonomous agent needs the read loop as Tools: read_resource (one-Web —
// local URIs hit the same resolver as resources/read; any other origin is a
// federation-gated remote read, absorbed verbatim from the retired
// read_remote_resource) and list_resources (the model-callable twin of
// resources/list). `links` carries the affordances HTTP puts in headers —
// MCP results have no header slot, so without it they'd be silently stripped
// (JSON-LD 1.1 syntax §6.1 context link / §6.2 alternate; surfaced, never
// applied — the agent dereferences them itself with read_resource).
import * as storage from '../storage/filesystem.js';
import { buildUrl, parentPath } from './wac.js';
import { sanitizeTypes, sanitizeField } from './sanitize.js';
import { describedbyTargets } from '../lws/constraint.js';
import { storageDescriptionUrl } from '../lws/storage-description.js';

const JSONLD_CONTEXT_REL = 'http://www.w3.org/ns/json-ld#context';

// The JSON-LD-relevant subset of an RFC 8288 Link header, for the remote arm.
// context: json-ld#context (ordinary-JSON upgrade path, JSON-LD 1.1 §6.1);
// alternate: rel="alternate" typed ld+json (§6.2); linkset: RFC 9264. The
// spec allows at most one context link — a malformed multi-link response
// keeps the last one seen. Targets are client-controlled -> sanitizeField.
export function parseRemoteLinks(header) {
  const links = {};
  if (!header || typeof header !== 'string') return links;
  // Split on commas that begin a new <target>; commas inside params survive.
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = part.match(/^\s*<([^>]*)>\s*((?:;[^;]*)*)$/);
    if (!m) continue;
    const params = {};
    for (const p of m[2].split(';')) {
      const kv = p.match(/^\s*([a-zA-Z0-9*_-]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (kv) params[kv[1].toLowerCase()] = kv[2];
    }
    const rels = (params.rel || '').split(/\s+/);
    if (rels.includes(JSONLD_CONTEXT_REL)) links.context = sanitizeField(m[1]);
    else if (rels.includes('alternate') && params.type === 'application/ld+json') links.alternate = sanitizeField(m[1]);
    else if (rels.includes('linkset')) links.linkset = sanitizeField(m[1]);
  }
  return links;
}

// The local read's header-borne affordances, derived from the SAME sources as
// the HTTP Link headers / linkset (constraint store, storage description) —
// one source, no drift. describedby omitted when no shape is declared.
export async function localLinks(path, ctx) {
  const links = { storageDescription: storageDescriptionUrl(buildUrl(ctx, path)) };
  if (path !== '/') links.up = buildUrl(ctx, parentPath(path));
  const shapes = sanitizeTypes(await describedbyTargets(storage, path + '.meta', buildUrl(ctx, path)));
  if (shapes.length) links.describedby = shapes;
  return links;
}
