// src/lws/type-metadata.js
// Server-managed `type` metadata (LWS metadata.md: `type` is System-Managed,
// read-only to clients). Stored in a server-only `.lwstypes` sidecar — NOT the
// client-managed .meta/Description Resource.
import { isAbsoluteUri } from './type-index.js';

export function typeStorePath(storagePath) {
  return storagePath + '.lwstypes';
}

// RFC 8288 Link header → absolute URIs whose rel token set includes "type".
export function parseTypeLinks(linkHeader = '') {
  const out = [];
  // Split on commas that separate link-values: "<uri>; params, <uri>; params".
  const parts = linkHeader.split(/,(?=\s*<)/);
  for (const part of parts) {
    const m = part.match(/<([^>]*)>\s*;\s*(.*)$/);
    if (!m) continue;
    const target = m[1].trim();
    const rels = (m[2].match(/rel\s*=\s*"?([^";]+)"?/i) || [])[1];
    if (!rels) continue;
    if (!rels.split(/\s+/).includes('type')) continue;
    if (isAbsoluteUri(target) && !out.includes(target)) out.push(target);
  }
  return out;
}

export async function captureDeclaredTypes(storage, storagePath, typeUris) {
  // Persist only absolute-URI types. The HTTP Link path already filtered via
  // parseTypeLinks; the MCP `types` param reaches here unfiltered, so validate
  // here too — the sole choke point — so no free-text/relative value is ever
  // stored (review #2). Dedupe, order-preserved.
  const clean = [];
  for (const t of (typeUris || [])) if (isAbsoluteUri(t) && !clean.includes(t)) clean.push(t);
  if (!clean.length) return;                                 // nothing to persist
  await storage.write(typeStorePath(storagePath), Buffer.from(JSON.stringify(clean)));
}

export async function readDeclaredTypes(storage, storagePath) {
  const p = typeStorePath(storagePath);
  if (!(await storage.exists(p))) return [];
  const buf = await storage.read(p);
  if (!buf) return [];
  try { const arr = JSON.parse(buf.toString('utf8')); return Array.isArray(arr) ? arr : []; }
  catch { return []; }
}
