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
  // Sniff media type: stored JSON-LD is an object ('{') OR — for multi-subject
  // docs converted from Turtle on the conneg write path, i.e. any realistic
  // SHACL file published as text/turtle — a top-level ARRAY ('['). Everything
  // else is treated as Turtle/N3. Missing the array form sent JSON bytes to the
  // n3 parser and 500'd every write into the bound container ("Expected entity
  // but got {" — the ld+json-500 bug); SHACL never ran there.
  const first = shapeBuf.toString('utf8').trimStart()[0];
  const shapeCt = (first === '{' || first === '[')
    ? 'application/ld+json'
    : 'text/turtle';
  // A corrupt/unparseable declared shape degrades to pass — same stance as the
  // unresolvable-shape read above (a server-side config problem is never the
  // writer's 4xx). An unparseable BODY in a governed container is the writer's
  // problem: reject with a teaching violation (400 via the existing plumbing),
  // never a 500 and never a silent admit (the ld+json-500 lesson).
  let shapeDs;
  try { shapeDs = await toDataset(shapeBuf, shapeCt, shapeUrl); } catch { return pass(); }
  let dataDs;
  try {
    dataDs = await toDataset(content, contentType, resourceUrl);
  } catch (e) {
    return {
      decision: 'reject', shapeUrl,
      violations: [{
        severity: 'Violation',
        message: `body is not parseable as ${(contentType || '').split(';')[0].trim()} (${e.message}) — this container validates writes against ${shapeUrl}`,
        path: null, focusNode: null, value: null,
      }],
      advisories: [],
    };
  }
  const { results } = await validate(dataDs, shapeDs);

  const violations = results.filter(r => r.severity === 'Violation');
  const advisories = results.filter(r => r.severity !== 'Violation');
  return {
    decision: violations.length ? 'reject' : 'admit',
    shapeUrl, violations, advisories,
  };
}
