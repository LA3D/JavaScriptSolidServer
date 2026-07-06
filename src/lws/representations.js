// src/lws/representations.js
// Reads a resource's alternate-representation declarations (DX-PROF-CONNEG
// altr: model) from its client-managed .meta. Opaque: no profile-hierarchy
// resolution (P13) — conformsTo/format are surfaced verbatim. [] when .meta
// is missing/unreadable, mirroring src/lws/constraint.js.
import { toDataset } from './admission-rdf.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const HAS_DEFAULT = ALTR + 'hasDefaultRepresentation';
const HAS_REP = ALTR + 'hasRepresentation';
const DCT_FORMAT = 'http://purl.org/dc/terms/format';
const DCT_CONFORMS = 'http://purl.org/dc/terms/conformsTo';

function repFrom(ds, repTerm, baseIri) {
  const href = repTerm.termType === 'NamedNode' ? repTerm.value : baseIri;
  let format = null, profile = null;
  for (const q of ds) {
    if (q.subject.value !== repTerm.value) continue;
    if (q.predicate.value === DCT_FORMAT) format = q.object.value;
    else if (q.predicate.value === DCT_CONFORMS) profile = q.object.value;
  }
  return { href, format, profile };
}

export async function readRepresentations(storage, metaPath, baseIri) {
  const empty = { default: null, alternates: [] };
  if (!(await storage.exists(metaPath))) return empty;
  let buf;
  try { buf = await storage.read(metaPath); } catch { return empty; }
  let ds;
  try { ds = await toDataset(buf, 'application/ld+json', baseIri); } catch { return empty; }
  let def = null;
  const alternates = [];
  for (const q of ds) {
    if (q.predicate.value === HAS_DEFAULT) def = repFrom(ds, q.object, baseIri);
    else if (q.predicate.value === HAS_REP) alternates.push(repFrom(ds, q.object, baseIri));
  }
  return { default: def, alternates };
}
