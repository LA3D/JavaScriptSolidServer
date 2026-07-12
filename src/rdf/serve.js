// src/rdf/serve.js
// The --lws serving arm (spec 2026-07-10 §2): stored RDF bytes → negotiated
// quads serialization via the real parser (toDataset) + the n3 writer.
// Policy: a conversion that would lose triples (named graphs into Turtle/
// N-Triples) or that cannot run offline (remote @context) answers 406 with a
// teaching problem+json — never a silent 200 with empty or mislabeled bytes
// (the probe-#4 family). LWS mandates media conneg be lossless.
import { Writer } from 'n3';
import jsonld from 'jsonld';
import { toDataset } from './dataset.js';
import { RDF_TYPES } from './conneg.js';
import { COMMON_PREFIXES, applyTerminatorSpacing } from './turtle.js';

// Negotiated type → served output type. N3 requests serve Turtle (existing
// behavior — Turtle is valid N3). Absence from this map = not a quads target.
export const QUADS_OUTPUTS = {
  [RDF_TYPES.TURTLE]: RDF_TYPES.TURTLE,
  [RDF_TYPES.N3]: RDF_TYPES.TURTLE,
  [RDF_TYPES.NTRIPLES]: RDF_TYPES.NTRIPLES,
  [RDF_TYPES.NQUADS]: RDF_TYPES.NQUADS,
};
const N3_FORMATS = {
  [RDF_TYPES.TURTLE]: 'Turtle',
  [RDF_TYPES.NTRIPLES]: 'N-Triples',
  [RDF_TYPES.NQUADS]: 'N-Quads',
};
// JSON-LD is graph-capable too — jsonld.fromRDF is lossless for named graphs
// (review #6: it was missing here, so a named-graph source 406'd even to JSON-LD).
const GRAPH_CAPABLE = new Set([RDF_TYPES.NQUADS, RDF_TYPES.JSON_LD]);

// Serving-arm source gate (spec 2026-07-11 §2): what counts as an RDF SOURCE.
// Deliberately narrower than utils/url.js isRdfContentType — plain application/json
// is NOT RDF for serving (probe-#6: it parsed as JSON-LD to zero quads → empty
// Turtle 200). The legacy predicate stays for --lws-off byte-identity.
const RDF_SOURCE_TYPES = new Set([
  RDF_TYPES.JSON_LD, RDF_TYPES.TURTLE, RDF_TYPES.N3, RDF_TYPES.NTRIPLES, RDF_TYPES.NQUADS,
]);
export function isRdfSourceType(contentType) {
  return RDF_SOURCE_TYPES.has((contentType || '').split(';')[0].trim().toLowerCase());
}

export function hasNamedGraphs(dataset) {
  for (const q of dataset) if (q.graph.termType !== 'DefaultGraph') return true;
  return false;
}

export function datasetToFormat(dataset, targetType) {
  return new Promise((resolve, reject) => {
    const format = N3_FORMATS[targetType];
    if (!format) return reject(new Error(`unsupported quads output: ${targetType}`));
    const writer = targetType === RDF_TYPES.TURTLE
      ? new Writer({ prefixes: COMMON_PREFIXES })
      : new Writer({ format });
    for (const q of dataset) writer.addQuad(q);
    writer.end((err, result) => err
      ? reject(err)
      : resolve(targetType === RDF_TYPES.TURTLE ? applyTerminatorSpacing(result) : result));
  });
}

// Dataset (default graph only — callers gate named graphs via GRAPH_CAPABLE)
// → expanded JSON-LD (spec JSON-LD 1.1 §"Expanded Document Form"): no
// @context, every predicate a full IRI, every value an array of value
// objects. Real conversion via the `jsonld` library's fromRDF (the spec's
// RDF-to-JSON-LD algorithm) — not a hand-rolled quad walk. The dataset seam
// already produces N-Quads for the n-quads serving arm (the n3 Writer via
// datasetToFormat); reuse that string as jsonld.fromRDF's input.
async function datasetToJsonLd(dataset) {
  const nquads = await datasetToFormat(dataset, RDF_TYPES.NQUADS);
  return jsonld.fromRDF(nquads, { format: 'application/n-quads' });
}

function notAcceptable(instance, targetType, why, works) {
  return {
    ok: false,
    status: 406,
    problem: {
      type: 'about:blank',
      title: 'Not Acceptable',
      status: 406,
      detail: `cannot serve this resource as ${targetType}: ${why} Formats that work: ${works.join(', ')}.`,
      instance,
    },
  };
}

/** F3: a non-RDF source cannot satisfy a specific media Accept — teach, never lie. */
export function nonRdfNotAcceptable(instance, storedType, requestedAccept, hasAlternates) {
  const route = hasAlternates
    ? ' Its declared representations are in the Link header (rel="canonical"/"alternate"), or send Accept-Profile: <profile-uri> to negotiate one.'
    : ' If this resource has profile-negotiated representations, send Accept-Profile: <profile-uri> to negotiate one (its linkset, Accept: application/linkset+json, lists what is declared).';
  return { ok: false, status: 406, problem: {
    type: 'about:blank', title: 'Not Acceptable', status: 406,
    detail: `this resource is ${storedType} and has no representation matching "${requestedAccept}".${route} Formats that work directly: ${storedType}.`,
    instance,
  } };
}

async function policyDataset({ bytes, sourceContentType, targetType, baseIri }) {
  let dataset;
  try {
    dataset = await toDataset(bytes, sourceContentType, baseIri);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const remoteCtx = msg.includes('remote @context fetch disabled');
    return notAcceptable(baseIri, targetType,
      `the stored document did not parse as ${sourceContentType} (${msg})${remoteCtx ? ' — a remote @context cannot be fetched (offline document loader).' : '.'}`,
      [RDF_TYPES.JSON_LD]);
  }
  if (!GRAPH_CAPABLE.has(targetType) && hasNamedGraphs(dataset)) {
    return notAcceptable(baseIri, targetType,
      'the document contains named graphs, which this format cannot express losslessly.',
      [RDF_TYPES.JSON_LD, RDF_TYPES.NQUADS]);
  }
  return { ok: true, dataset };
}

// Own format = bytes are bytes; conversions = parse or teach. N3 is excluded
// because QUADS_OUTPUTS maps it to Turtle — serving N3 bytes labeled
// text/turtle would mislabel; N3 sources still go through the parser.
const isOwnFormat = (sourceContentType, targetType) =>
  QUADS_OUTPUTS[sourceContentType] === targetType && sourceContentType !== RDF_TYPES.N3;

/** Serve stored RDF bytes as a quads format (or JSON-LD) under the 406-teaching policy. */
export async function serveStoredRdf({ bytes, sourceContentType = RDF_TYPES.JSON_LD, targetType, baseIri }) {
  if (isOwnFormat(sourceContentType, targetType)) {
    return { ok: true, content: bytes, contentType: sourceContentType };
  }
  const p = await policyDataset({ bytes, sourceContentType, targetType, baseIri });
  if (!p.ok) return p;
  if (targetType === RDF_TYPES.JSON_LD) {
    const doc = await datasetToJsonLd(p.dataset);
    return { ok: true, content: JSON.stringify(doc, null, 2), contentType: RDF_TYPES.JSON_LD };
  }
  const content = await datasetToFormat(p.dataset, targetType);
  return { ok: true, content, contentType: targetType };
}

/** The same policy WITHOUT serializing — HEAD parity (#552 discipline). */
export async function checkServable({ bytes, sourceContentType = RDF_TYPES.JSON_LD, targetType, baseIri }) {
  if (isOwnFormat(sourceContentType, targetType)) return { ok: true };
  const p = await policyDataset({ bytes, sourceContentType, targetType, baseIri });
  return { ok: p.ok };
}
