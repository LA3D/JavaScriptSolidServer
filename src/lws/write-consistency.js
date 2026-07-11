// src/lws/write-consistency.js
// Spec §2: under --lws, extension-derived typing must not lie. A write whose target
// name implies one RDF media type while the body declares another (or an RDF body at
// an extension-less name that would serve as octet-stream) is refused with a teaching
// 400 — so the stored bytes, the served Content-Type, and items[].mediaType all agree.
//
// JSON-LD is deliberately EXCLUDED: it's JSS's native on-disk format and the write
// path never transformed it (the B1 defect this gate closes is specific to the
// Turtle/N3→JSON-LD conversion that silently changed bytes while keeping the
// client's chosen extension). Extensionless JSON-LD is JSS's standard resource-
// creation idiom (POST slug-less create, MCP shape/typed-resource writes, ACL/.meta) —
// getContentType() already falls back to content-sniffing for it at read time, so
// there's no name/type lie to catch here the way there is for Turtle/N3/N-Triples/N-Quads.
import { getContentType } from '../utils/url.js';
import { RDF_TYPES } from '../rdf/conneg.js';

const RDF = new Set([RDF_TYPES.TURTLE, RDF_TYPES.N3, RDF_TYPES.NTRIPLES, RDF_TYPES.NQUADS]);
const main = (t) => (t || '').split(';')[0].trim().toLowerCase();

export function writeTypeConsistency({ urlPath, submittedType, lwsEnabled }) {
  if (!lwsEnabled) return { ok: true };
  const sub = main(submittedType);
  if (!RDF.has(sub)) return { ok: true };                 // non-RDF bodies (incl. JSON-LD): not our concern
  const nameType = main(getContentType(urlPath));         // extension-derived (octet-stream if none)
  if (nameType === 'application/octet-stream') {
    return problem(urlPath, sub, `the resource name has no extension, so it would be served as application/octet-stream; name it with an extension matching ${sub} (e.g. .ttl for text/turtle, .n3 for text/n3)`);
  }
  if (nameType !== sub) {
    return problem(urlPath, sub, `the resource name implies ${nameType} but the body is ${sub}; rename to match the body's type or submit the body as ${nameType}`);
  }
  return { ok: true };
}

function problem(instance, sub, detail) {
  return { ok: false, problem: { type: 'about:blank', title: 'Bad Request', status: 400, detail, instance } };
}
