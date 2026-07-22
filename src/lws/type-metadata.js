// src/lws/type-metadata.js
// Server-managed `type` metadata (LWS metadata.md: `type` is System-Managed,
// read-only to clients). Stored in a server-only `.lwstypes` sidecar — NOT the
// client-managed .meta/Description Resource.
import { isAbsoluteUri } from './type-index.js';

// Multi-tenant storage round: the marker stamped on every pod root's
// .lwstypes at provisioning, so a storage-resolver can find the tenant
// boundary by type rather than by pod-name convention.
export const LWS_STORAGE = 'https://www.w3.org/ns/lws#Storage';

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

// Merge one type into `.lwstypes` without clobbering what's there —
// captureDeclaredTypes overwrites by design (provisioning), but the boot
// backfill (governance round 2026-07-22) touches roots that may already
// carry client-declared types. Returns true only when it wrote.
export async function ensureDeclaredType(storage, storagePath, typeUri) {
  const existing = await readDeclaredTypes(storage, storagePath);
  if (existing.includes(typeUri)) return false;
  await storage.write(typeStorePath(storagePath), Buffer.from(JSON.stringify([...existing, typeUri])));
  return true;
}

// Per-storage owner record (governance round 2026-07-22): solid:owner URIs
// for a storage root, System-Managed like `.lwstypes`. In-storage (not
// config) because ownership travels with the data on re-homing; the
// deployment operator (schema:provider) is config precisely because it
// does not. Design: docs/superpowers/specs/2026-07-22-* in lws-pod.
export function ownerStorePath(storagePath) {
  return storagePath + '.lwsowner';
}

export async function readOwners(storage, storagePath) {
  const p = ownerStorePath(storagePath);
  if (!(await storage.exists(p))) return [];
  const buf = await storage.read(p);
  if (!buf) return [];
  try { const arr = JSON.parse(buf.toString('utf8')); return Array.isArray(arr) ? arr.filter((o) => isAbsoluteUri(o)) : []; }
  catch { return []; }
}

export async function writeOwners(storage, storagePath, ownerUris) {
  const clean = [];
  for (const o of (ownerUris || [])) if (isAbsoluteUri(o) && !clean.includes(o)) clean.push(o);
  if (!clean.length) return;                                  // ≥1 owner or no record
  await storage.write(ownerStorePath(storagePath), Buffer.from(JSON.stringify(clean)));
}

// Earned conformsTo provenance (System-Managed): which profile a member's
// CONTAINER declared at the moment the member was admitted. Distinct from
// the client-managed `.meta` dct:conformsTo (declared binding intent) — a
// separate `.lwsprov` sidecar, not folded into `.lwstypes` (a plain
// type-URI array), keeps both shapes simple.
export function provStorePath(storagePath) {
  return storagePath + '.lwsprov';
}

export async function readProvenance(storage, storagePath) {
  const p = provStorePath(storagePath);
  if (!(await storage.exists(p))) return null;
  const buf = await storage.read(p);
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8')); }
  catch { return null; }
}

export async function writeProvenance(storage, storagePath, prov) {
  await storage.write(provStorePath(storagePath), Buffer.from(JSON.stringify(prov)));
}
