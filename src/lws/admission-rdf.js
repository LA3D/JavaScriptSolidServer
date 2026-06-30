// src/lws/admission-rdf.js
// Turns request/stored bytes into an RDF/JS DatasetCore the SHACL seam can
// validate. JSON-LD is converted to Turtle via JSS's own serializer (no new
// JSON-LD parser dep), then parsed by n3 inside datasetFromTurtle.
//
// ADAPTATION NOTE: fromJsonLd returns { content, contentType }, not a bare
// string. The brief's String(ttl) guard would yield "[object Object]". We
// extract result.content instead — confirmed by reading src/rdf/conneg.js:174.
import { datasetFromTurtle } from './shacl.js';
import { fromJsonLd, RDF_TYPES } from '../rdf/conneg.js';

const main = ct => (ct || '').split(';')[0].trim().toLowerCase();

export function isRdfBody(contentType) {
  const t = main(contentType);
  return t === RDF_TYPES.TURTLE || t === RDF_TYPES.N3 || t === RDF_TYPES.JSON_LD || t === 'application/json';
}

// Buffer (any accepted RDF media type) → RDF/JS DatasetCore. JSON-LD is
// converted to Turtle via JSS's own serializer (connegEnabled=true), then
// n3-parsed by datasetFromTurtle. fromJsonLd returns { content, contentType }
// so we extract .content for the Turtle string.
export async function toDataset(buffer, contentType, baseIri) {
  const t = main(contentType);
  if (t === RDF_TYPES.TURTLE || t === RDF_TYPES.N3) {
    return datasetFromTurtle(buffer.toString('utf8'), baseIri);
  }
  const jsonLd = JSON.parse(buffer.toString('utf8'));
  const result = await fromJsonLd(jsonLd, RDF_TYPES.TURTLE, baseIri, true);
  // result is { content: string, contentType: string } — extract the Turtle
  const ttl = result?.content ?? String(result);
  return datasetFromTurtle(ttl, baseIri);
}
