// src/lws/constraint.js
import { toDataset } from './admission-rdf.js';

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';
const DCT_CONFORMS = 'http://purl.org/dc/terms/conformsTo';

// All <predicateIri> targets in a resource's .meta (the LWS linkset resource).
// [] when .meta is missing/unreadable/parse-corrupt — treated as "declares
// nothing". Deduped, order-preserved.
export async function metaTargets(storage, metaPath, baseIri, predicateIri) {
  if (!(await storage.exists(metaPath))) return [];
  let buf;
  try { buf = await storage.read(metaPath); } catch { return []; }
  let ds;
  try { ds = await toDataset(buf, 'application/ld+json', baseIri); } catch { return []; }
  const out = [];
  for (const q of ds) if (q.predicate.value === predicateIri && !out.includes(q.object.value)) out.push(q.object.value);
  return out;
}

export async function describedbyTargets(storage, metaPath, baseIri) {
  return metaTargets(storage, metaPath, baseIri, DESCRIBEDBY);
}

// The profile handoff edge (Plan 2): the target's own declared dct:conformsTo.
// Inheritance/pod-defaults are client-resolver semantics — never read here.
export async function conformsToTargets(storage, metaPath, baseIri) {
  return metaTargets(storage, metaPath, baseIri, DCT_CONFORMS);
}

async function describedbyFrom(storage, metaPath, baseIri) {
  return (await describedbyTargets(storage, metaPath, baseIri))[0] ?? null;
}

// Target's own .meta wins (self-constraint); else the container's .meta
// (member-rule for a newly created resource). null = unconstrained → pass through.
export async function resolveShapeUrl({ storage, targetMetaPath, containerMetaPath, baseIri }) {
  return (await describedbyFrom(storage, targetMetaPath, baseIri))
      ?? (await describedbyFrom(storage, containerMetaPath, baseIri));
}
