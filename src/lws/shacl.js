// src/lws/shacl.js
// The ONLY importer of shacl-engine (pinned to the 1.2 SHA). If the 1.2 API
// drifts, fix it here — admission code stays engine-agnostic.
//
// API note: at SHA ce39d07 the package exports `Engine` (not `Validator` as the
// published 1.0.x README describes). The validate() signature is also different:
//   new Engine(shapesDataset, { factory })
//   const report = await engine.validate({ dataset })
// Path is an array of step-objects ({ predicates: [NamedNode], ... }), not a
// NamedNode; focusNode is a grapoi PathList, not a term. Both differences are
// handled in norm() below and verified by lws-shacl.test.js.
import rdf from 'rdf-ext';
import { Parser } from 'n3';
import { Engine } from 'shacl-engine';

const SH = 'http://www.w3.org/ns/shacl#';

export function datasetFromTurtle(ttl, baseIri) {
  return rdf.dataset(new Parser({ baseIRI: baseIri }).parse(ttl));
}

// Normalize a 1.2 result to our stable shape. Accessors are pinned by
// lws-shacl.test.js — only change here if the upstream SHA changes.
function norm(r) {
  // severity is a NamedNode, e.g. NamedNode { id: 'http://...shacl#Violation' }
  const sev = (r.severity?.value || SH + 'Violation').split('#')[1] || 'Violation';

  // message is a getter returning an array of Literal objects
  const msg = Array.isArray(r.message)
    ? (r.message[0]?.value ?? r.message[0])
    : (r.message?.value ?? r.message);

  // path is an array of step-objects: [{ quantifier, predicates: [NamedNode] }]
  // For simple sh:path <predicate> this is always a single step with one predicate.
  const path = r.path?.[0]?.predicates?.[0]?.value ?? null;

  // focusNode is a grapoi PathList; .term gives the NamedNode/BlankNode
  const focusNode = r.focusNode?.term?.value ?? null;

  // value is a PathList or undefined for cardinality violations
  const value = r.value?.term?.value ?? r.value?.value ?? null;

  return {
    severity: sev,                       // 'Violation' | 'Warning' | 'Info'
    message: msg || 'constraint violation',
    path,
    focusNode,
    value,
  };
}

export async function validate(dataDataset, shapeDataset) {
  const engine = new Engine(shapeDataset, { factory: rdf });
  const report = await engine.validate({ dataset: dataDataset });
  const results = (report.results || []).map(norm);
  return { conforms: report.conforms === true, results };
}
