// src/rdf/dataset.js
// The shared "bytes → RDF/JS DatasetCore" seam for BOTH the SHACL admission
// path and the --lws serving arm (src/rdf/serve.js). JSON-LD is parsed by
// @rdfjs/parser-jsonld — a real JSON-LD 1.1 processor: array and aliased
// @context, @graph, @value all handled. (Promoted from src/lws/admission-rdf.js
// in the serving-path round; the legacy store-array shim is retired — a
// top-level array is standard JSON-LD now.)
//
// Remote @context fetch is DISABLED (no-network documentLoader — SSRF
// discipline, cf. PATCH_CID_PRIVATE_IPS): the sole preload is the LWS v1
// context, served from the pod's own resolvable mirror (src/lws/context.js).
// Parse failures THROW — fail loud; callers choose degrade-vs-reject
// (constraint/representations catch → empty; admission maps body failures to
// a teaching 400; serving maps them to a teaching 406).
import { Readable } from 'node:stream';
import ParserJsonld from '@rdfjs/parser-jsonld';
import rdf from 'rdf-ext';
import { datasetFromTurtle } from '../lws/shacl.js';
import { RDF_TYPES } from './conneg.js';
import { LWS_CONTEXT_OBJECT } from '../lws/context.js';

const main = ct => (ct || '').split(';')[0].trim().toLowerCase();

export function isRdfBody(contentType) {
  const t = main(contentType);
  return t === RDF_TYPES.TURTLE || t === RDF_TYPES.N3 || t === RDF_TYPES.JSON_LD || t === 'application/json';
}

const LWS_CONTEXT_URL = 'https://www.w3.org/ns/lws/v1';

// jsonld-streaming-parser IDocumentLoader: an object exposing load(url) that
// resolves to the raw context document. NOT the jsonld.js function-style
// loader — the interfaces differ.
const documentLoader = {
  async load(url) {
    if (url === LWS_CONTEXT_URL) return { '@context': LWS_CONTEXT_OBJECT };
    throw new Error(`remote @context fetch disabled: ${url}`);
  },
};

// Buffer (any accepted RDF media type) → RDF/JS DatasetCore.
export async function toDataset(buffer, contentType, baseIri) {
  const t = main(contentType);
  if (t === RDF_TYPES.TURTLE || t === RDF_TYPES.N3) {
    return datasetFromTurtle(buffer.toString('utf8'), baseIri);
  }
  const text = buffer.toString('utf8');
  // Fail loud: empty body must not become a vacuous empty dataset (violates the contract).
  if (!text.trim()) throw new Error('empty JSON-LD body');
  const parser = new ParserJsonld({ documentLoader, baseIRI: baseIri });
  return rdf.dataset().import(parser.import(Readable.from([text])));
}
