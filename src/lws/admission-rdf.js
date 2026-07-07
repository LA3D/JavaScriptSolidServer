// src/lws/admission-rdf.js
// Turns request/stored bytes into an RDF/JS DatasetCore the SHACL seam can
// validate. JSON-LD is parsed by @rdfjs/parser-jsonld — the rdf-ext family the
// SHACL seam already rides — i.e. a real JSON-LD 1.1 processor: array and
// aliased @context, @graph, @value all handled. (Replaces the hand-rolled
// jsonLdToQuads bridge, whose naive context merge silently produced ZERO quads
// for array/remote @context and @graph bodies — silent under-validation, the
// ld+json-500 family.)
//
// Remote @context fetch is DISABLED (no-network documentLoader — SSRF
// discipline, cf. PATCH_CID_PRIVATE_IPS): the sole preload is the LWS v1
// context, served from the pod's own resolvable mirror (src/lws/context.js).
// Parse failures THROW — fail loud, never silently skip the floor; callers
// choose degrade-vs-reject (constraint/representations catch → empty;
// admission maps body failures to a teaching 400).
import { Readable } from 'node:stream';
import ParserJsonld from '@rdfjs/parser-jsonld';
import rdf from 'rdf-ext';
import { datasetFromTurtle } from './shacl.js';
import { RDF_TYPES } from '../rdf/conneg.js';
import { LWS_CONTEXT_OBJECT } from './context.js';

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

// JSS store-format shim: JSS's own toJsonLd serializes multi-subject docs as a
// top-level array with @context ONLY on element 0 — NOT self-describing
// JSON-LD (standard expansion gives elements 1..n no prefix definitions,
// orphaning e.g. a shape's sh:property restriction → vacuous validation). The
// old hand-rolled bridge read it back only because it shared the same
// non-standard cross-element context merge. Until the serializer round retires
// that store form ({@context, @graph}), fill each context-less element from
// element 0's context; elements carrying their own @context keep it.
function shimLegacyStoreArray(doc) {
  if (!Array.isArray(doc) || !doc.length) return doc;
  const ctx = doc[0] && typeof doc[0] === 'object' ? doc[0]['@context'] : undefined;
  if (!ctx) return doc;
  return doc.map((el) =>
    el && typeof el === 'object' && !Array.isArray(el) && !('@context' in el) ? { '@context': ctx, ...el } : el);
}

// Buffer (any accepted RDF media type) → RDF/JS DatasetCore.
export async function toDataset(buffer, contentType, baseIri) {
  const t = main(contentType);
  if (t === RDF_TYPES.TURTLE || t === RDF_TYPES.N3) {
    return datasetFromTurtle(buffer.toString('utf8'), baseIri);
  }
  const doc = shimLegacyStoreArray(JSON.parse(buffer.toString('utf8')));
  const parser = new ParserJsonld({ documentLoader, baseIRI: baseIri });
  return rdf.dataset().import(parser.import(Readable.from([JSON.stringify(doc)])));
}
