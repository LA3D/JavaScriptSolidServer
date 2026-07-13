// src/lws/subject-types.js
// Referent identity & discovery (2026-07-13): derive the primary referent's
// rdf:type from an RDF write body — the LWS-encouraged content-derivation path
// (lws10-searchindex §Type-and-Relation-Derivation ¶2). Vocabulary-blind.
import { toDataset, isRdfBody } from '../rdf/dataset.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// Primary-referent-only rule: return the type URIs iff EXACTLY ONE distinct
// named subject in the body carries an rdf:type. Zero → []. More than one (an
// aggregate / multi-@graph dataset) → [] (secondary-subject indexing is the
// deferred extension). Never throws — a parse failure yields [].
export async function subjectTypesFromBody(content, contentType, baseIri) {
  if (!isRdfBody(contentType)) return [];
  let ds;
  try { ds = await toDataset(content, contentType, baseIri); } catch { return []; }
  const bySubject = new Map();
  for (const q of ds) {
    if (q.predicate.value !== RDF_TYPE) continue;
    if (q.subject.termType !== 'NamedNode' || q.object.termType !== 'NamedNode') continue;
    if (!bySubject.has(q.subject.value)) bySubject.set(q.subject.value, new Set());
    bySubject.get(q.subject.value).add(q.object.value);
  }
  if (bySubject.size !== 1) return [];
  return [...[...bySubject.values()][0]];
}
