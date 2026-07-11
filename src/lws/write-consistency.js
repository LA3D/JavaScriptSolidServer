// src/lws/write-consistency.js
// Spec §2: under --lws, extension-derived typing must not lie. A write whose target
// name implies one RDF media type while the body declares another (or an RDF body at
// an extension-less name that would serve as octet-stream) is refused with a teaching
// 400 — so the stored bytes, the served Content-Type, and items[].mediaType all agree.
//
// JSON-LD stays IN the gate (B1 fix round 1 review): the write path stores it verbatim
// like every other RDF type now, so a JSON-LD body at a Turtle/N3/N-Triples/N-Quads-
// named path is the exact name/type lie this gate exists to catch. Two shapes are
// legitimate and pass: extensionless (application/octet-stream — JSS's standard
// resource-creation idiom: POST slug-less create, MCP shape/typed-resource writes,
// ACL/.meta) and `.jsonld` (application/ld+json) — getContentType() maps both .acl
// and .meta basenames straight to application/ld+json too, so those fall into the
// second shape rather than needing a special case.
import { getContentType } from '../utils/url.js';
import { RDF_TYPES } from '../rdf/conneg.js';

// The other RDF serializations — the only names a JSON-LD body may NOT sit at.
const OTHER_RDF = new Set([RDF_TYPES.TURTLE, RDF_TYPES.N3, RDF_TYPES.NTRIPLES, RDF_TYPES.NQUADS]);
const RDF = new Set([...OTHER_RDF, RDF_TYPES.JSON_LD]);
const main = (t) => (t || '').split(';')[0].trim().toLowerCase();

export function writeTypeConsistency({ urlPath, submittedType, lwsEnabled }) {
  if (!lwsEnabled) return { ok: true };
  const sub = main(submittedType);
  if (!RDF.has(sub)) return { ok: true };                 // non-RDF bodies: not our concern
  const nameType = main(getContentType(urlPath));         // extension-derived (octet-stream if none)

  if (sub === RDF_TYPES.JSON_LD) {
    // Only reject when the name implies a DIFFERENT RDF serialization — that's the
    // lie (B1). Extensionless and .jsonld/.acl/.meta (nameType === application/ld+json)
    // are both legitimate and fall through to ok below.
    if (OTHER_RDF.has(nameType)) {
      return problem(urlPath, sub, `the resource name implies ${nameType} but the body is ${sub}; rename to match the body's type or submit the body as ${nameType}`);
    }
    return { ok: true };
  }

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
