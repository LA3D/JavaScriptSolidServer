// src/lws/admission.js
// Orchestrator: resolve shape → load shape (media-type tolerant) → validate
// → partition severities → decide pass/admit/reject.
//
// AdmissionResult: { decision: 'pass'|'admit'|'reject', shapeUrl: string|null,
//                    violations: Result[], advisories: Result[] }
// 'pass'   = non-RDF body OR no constraint resolved (opt-in miss) — no validation run
// 'admit'  = constraint resolved, conforms or only Warning/Info results
// 'reject' = ≥1 Violation result
import { resolveShapeUrl } from './constraint.js';
import { toDataset, isRdfBody } from './admission-rdf.js';
import { validate } from './shacl.js';

const pass = () => ({ decision: 'pass', shapeUrl: null, violations: [], advisories: [] });

// RFC 9457 problem+json for a SHACL constraint violation, extended with results.
export function constraintProblem({ shapeUrl, violations, instance }) {
  return {
    type: 'https://www.w3.org/ns/lws#ShapeViolation',
    title: 'Resource does not conform to its declared shape',
    status: 400,
    detail: `${violations.length} violation(s) against ${shapeUrl}`,
    instance,
    describedby: shapeUrl,
    violations,
  };
}

// Map a shape/resource URL to its storage path (path-mode: pathname === storagePath).
export const urlToStoragePath = (u) => new URL(u).pathname;

export async function admit({ storage, content, contentType, resourceUrl,
                              targetMetaPath, containerMetaPath, shapeUrlToPath }) {
  if (!isRdfBody(contentType)) return pass();               // bytes are trusted; skip validation

  const shapeUrl = await resolveShapeUrl({ storage, targetMetaPath, containerMetaPath, baseIri: resourceUrl });
  if (!shapeUrl) return pass();                             // opt-in miss — no constraint declared

  // Treat an unresolvable declared shape as an opt-in miss (pass through) —
  // avoids a 500 when the .meta points to a missing or typo'd shape URL.
  let shapeBuf;
  try { shapeBuf = await storage.read(shapeUrlToPath(shapeUrl)); } catch { return pass(); }
  if (!shapeBuf) return pass();
  // Sniff media type: JSON-LD objects start with '{'; everything else is treated
  // as Turtle/N3 (Step 3a — makes the seam tolerant of both on-disk formats).
  const shapeCt = shapeBuf.toString('utf8').trimStart().startsWith('{')
    ? 'application/ld+json'
    : 'text/turtle';
  const shapeDs = await toDataset(shapeBuf, shapeCt, shapeUrl);
  const dataDs  = await toDataset(content, contentType, resourceUrl);
  const { results } = await validate(dataDs, shapeDs);

  const violations = results.filter(r => r.severity === 'Violation');
  const advisories = results.filter(r => r.severity !== 'Violation');
  return {
    decision: violations.length ? 'reject' : 'admit',
    shapeUrl, violations, advisories,
  };
}
