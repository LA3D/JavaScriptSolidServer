// src/rdf/serve.js
// The --lws serving arm (spec 2026-07-10 §2): stored RDF bytes → negotiated
// quads serialization via the real parser (toDataset) + the n3 writer.
// Policy: a conversion that would lose triples (named graphs into Turtle/
// N-Triples) or that cannot run offline (remote @context) answers 406 with a
// teaching problem+json — never a silent 200 with empty or mislabeled bytes
// (the probe-#4 family). LWS mandates media conneg be lossless.
import { Writer } from 'n3';
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
const GRAPH_CAPABLE = new Set([RDF_TYPES.NQUADS]);

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

async function policyDataset({ bytes, sourceContentType, targetType, baseIri }) {
  let dataset;
  try {
    dataset = await toDataset(bytes, sourceContentType, baseIri);
  } catch (e) {
    return notAcceptable(baseIri, targetType,
      `the stored document did not parse as ${sourceContentType} (${e.message}) — a remote @context cannot be fetched (offline document loader).`,
      [RDF_TYPES.JSON_LD]);
  }
  if (!GRAPH_CAPABLE.has(targetType) && hasNamedGraphs(dataset)) {
    return notAcceptable(baseIri, targetType,
      'the document contains named graphs, which this format cannot express losslessly.',
      [RDF_TYPES.JSON_LD, RDF_TYPES.NQUADS]);
  }
  return { ok: true, dataset };
}

/** Serve stored RDF bytes as a quads format under the 406-teaching policy. */
export async function serveStoredRdf({ bytes, sourceContentType = RDF_TYPES.JSON_LD, targetType, baseIri }) {
  const p = await policyDataset({ bytes, sourceContentType, targetType, baseIri });
  if (!p.ok) return p;
  const content = await datasetToFormat(p.dataset, targetType);
  return { ok: true, content, contentType: targetType };
}

/** The same policy WITHOUT serializing — HEAD parity (#552 discipline). */
export async function checkServable({ bytes, sourceContentType = RDF_TYPES.JSON_LD, targetType, baseIri }) {
  const p = await policyDataset({ bytes, sourceContentType, targetType, baseIri });
  return { ok: p.ok === true };
}
