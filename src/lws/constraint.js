// src/lws/constraint.js
import { toDataset } from './admission-rdf.js';

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';

async function describedbyFrom(storage, metaPath, baseIri) {
  if (!(await storage.exists(metaPath))) return null;
  let buf;
  try { buf = await storage.read(metaPath); } catch { return null; }
  const ds = await toDataset(buf, 'application/ld+json', baseIri);
  for (const q of ds) if (q.predicate.value === DESCRIBEDBY) return q.object.value;
  return null;
}

// Target's own .meta wins (self-constraint); else the container's .meta
// (member-rule for a newly created resource). null = unconstrained → pass through.
export async function resolveShapeUrl({ storage, targetMetaPath, containerMetaPath, baseIri }) {
  return (await describedbyFrom(storage, targetMetaPath, baseIri))
      ?? (await describedbyFrom(storage, containerMetaPath, baseIri));
}
