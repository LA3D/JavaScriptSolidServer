// src/lws/write-consistency.js
// Spec §2: under --lws, extension-derived typing must not lie. A write whose target
// name implies one RDF media type while the body declares another (or an RDF body at
// an extension-less name that would serve as octet-stream) is refused with a teaching
// 400 — so the stored bytes, the served Content-Type, and items[].mediaType all agree.
//
// JSON-LD stays IN the gate (B1 fix round 1 review): the write path stores it verbatim
// like every other RDF type now, so a JSON-LD body at a Turtle/N3/N-Triples/N-Quads-
// named path is the exact name/type lie this gate exists to catch. Two shapes are
// legitimate and pass: extensionless (application/octet-stream — JSON-LD's legacy
// creation idiom: MCP shape/typed-resource writes, ACL/.meta) and `.jsonld`
// (application/ld+json) — getContentType() maps both .acl and .meta basenames
// straight to application/ld+json too, so those fall into the second shape rather
// than needing a special case.
//
// Review 2026-07-12 (#2, #10): the gate runs inside applyLwsWrite now — the
// choke point every write surface (HTTP PUT/POST + all MCP write tools)
// shares — instead of at 2 HTTP call sites only. Two strengthenings: plain
// application/json gates as JSON-LD (#10, asRdf below); a non-RDF body at an
// RDF-extension name is refused (#2 — admission would skip SHACL for it on
// write, yet the serving path RDF-serves the name on read).
//
// Review 2026-07-12 (#9): POST slug-less create no longer relies on the
// extensionless-RDF shape above — the server derives the extension from the
// submitted RDF type (extensionForRdfType below) so a name it assigns itself
// never trips this gate. JSON-LD is the one type left extensionless by design.
import { getContentType } from '../utils/url.js';
import { RDF_TYPES } from '../rdf/conneg.js';

// The other RDF serializations — the only names a JSON-LD body may NOT sit at.
const OTHER_RDF = new Set([RDF_TYPES.TURTLE, RDF_TYPES.N3, RDF_TYPES.NTRIPLES, RDF_TYPES.NQUADS]);
const RDF = new Set([...OTHER_RDF, RDF_TYPES.JSON_LD]);
const main = (t) => (t || '').split(';')[0].trim().toLowerCase();
// #10 (review 2026-07-12): plain application/json gates as JSON-LD — the rest
// of the pipeline already reads it that way (isRdfType/toJsonLd/isRdfBody).
const asRdf = (t) => (t === 'application/json' ? RDF_TYPES.JSON_LD : t);

// #9: the canonical extension per gated RDF type — slug-less POST/create
// derives the server-assigned name from it so the gate's own rule is never
// violated by a name the SERVER chose. JSON-LD absent on purpose:
// extensionless JSON-LD is the legitimate legacy creation shape.
export const RDF_EXTENSIONS = {
  [RDF_TYPES.TURTLE]: '.ttl',
  [RDF_TYPES.N3]: '.n3',
  [RDF_TYPES.NTRIPLES]: '.nt',
  [RDF_TYPES.NQUADS]: '.nq',
};
export const extensionForRdfType = (contentType) => RDF_EXTENSIONS[main(contentType)] || '';

export function writeTypeConsistency({ urlPath, submittedType, lwsEnabled }) {
  if (!lwsEnabled) return { ok: true };
  const sub = asRdf(main(submittedType));
  const nameType = main(getContentType(urlPath));         // extension-derived (octet-stream if none)

  if (!RDF.has(sub)) {
    // #2 worst case (review 2026-07-12): a non-RDF body at an RDF-extension
    // name would be admission-skipped on write yet RDF-served on read.
    // Refuse the lie in this direction too — symmetric with the RDF-body-at-
    // wrong-name check below. Extensionless and non-RDF names stay legitimate
    // (not our concern).
    if (RDF.has(nameType)) {
      return problem(urlPath, sub || 'unspecified',
        `the resource name implies ${nameType} but the body is ${sub || 'unspecified'}; rename to a non-RDF extension or submit the body as ${nameType}`);
    }
    return { ok: true };
  }

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
