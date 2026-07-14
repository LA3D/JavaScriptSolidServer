// task-6 review (owner directive): PATCH on a verbatim-stored resource
// applies at the RDF TERM level — no JSON-LD document detour. n3-patch.js
// and sparql-update.js both hand back ground triples {subject, predicate,
// object}; object is a plain string, an {'@id': ...} / {value|@value,
// type|@type} / {value|@value, language|@language} object (sparql-update.js's
// shape), or an N3-Patch-only {blankNode} marker. A bare STRING object is
// only ambiguous (URI or literal) when it came from parseN3Patch — its own
// regex parser hands back the same bare-string shape for both (resolved
// the same way its legacy convertToJsonLd did: a bare http(s) string is a
// URI, anything else a plain literal). parseSparqlUpdate's bare strings are
// NEVER ambiguous — termToJsonLdValue only flattens a KNOWN xsd:string
// literal that way, always wrapping IRIs as {'@id':...} — so the
// http-heuristic must not run on SPARQL-sourced strings (finding 1, review
// round: it was corrupting URL-valued string literals into NamedNodes).
// termFromId/termFromPatchObject below build real n3 DataFactory terms;
// termFromPatchObject takes an `ambiguous` flag so each caller in
// applyPatchToDataset can say which shape-origin it's feeding it.
import { DataFactory as N3DataFactory } from 'n3';

const { namedNode: patchNamedNode, literal: patchLiteral, blankNode: patchBlankNode,
  quad: patchQuad, defaultGraph: patchDefaultGraph } = N3DataFactory;

export function termFromId(value) {
  return typeof value === 'string' && value.startsWith('_:')
    ? patchBlankNode(value.slice(2))
    : patchNamedNode(value);
}

// `ambiguous` is true only for N3-Patch-sourced objects, whose parser hands
// back a bare string for BOTH IRIs and plain literals (genuine ambiguity —
// resolveValue in n3-patch.js, see comment above). SPARQL's parser KNOWS
// the difference (termToJsonLdValue in sparql-update.js wraps IRIs as
// {'@id':...} and only flattens a KNOWN xsd:string literal to a bare
// string) — so a bare string from the SPARQL path must always be a
// literal, never run through the http-heuristic (finding 1: a
// "https://example.org" string literal was being corrupted into a
// NamedNode on INSERT, and DELETE against that same literal silently
// no-op'd because deleteMatches never matched a mistyped NamedNode).
export function termFromPatchObject(object, ambiguous) {
  if (typeof object === 'string') {
    return (ambiguous && (object.startsWith('http://') || object.startsWith('https://')))
      ? patchNamedNode(object)
      : patchLiteral(object);
  }
  if (object && typeof object === 'object') {
    if (object.blankNode !== undefined) return patchBlankNode(object.blankNode);
    if (object['@id'] !== undefined) return termFromId(object['@id']);
    const val = object.value !== undefined ? object.value : object['@value'];
    const type = object.type !== undefined ? object.type : object['@type'];
    const lang = object.language !== undefined ? object.language : object['@language'];
    if (val !== undefined && type !== undefined) return patchLiteral(val, patchNamedNode(type));
    if (val !== undefined && lang !== undefined) return patchLiteral(val, lang);
    if (val !== undefined) return patchLiteral(val);
  }
  return patchLiteral(String(object));
}

// Applies {deletes, inserts} directly on the rdf-ext dataset, scoped to the
// DEFAULT graph only: deletes that match nothing are silent no-ops (dataset
// deleteMatches over an empty match set is a no-op by construction — same
// observable behavior the old document-level deleteTriple had), and named
// graph quads in .nq-stored docs (non-default graph) are never touched, so
// they survive untouched. solid:where stays ignored (pre-existing gap, out
// of scope — neither parser's `where` array is consulted here either).
export function applyPatchToDataset(dataset, { deletes = [], inserts = [] }, ambiguous) {
  for (const t of deletes) {
    dataset.deleteMatches(
      termFromId(t.subject), patchNamedNode(t.predicate), termFromPatchObject(t.object, ambiguous), patchDefaultGraph());
  }
  for (const t of inserts) {
    dataset.add(patchQuad(
      termFromId(t.subject), patchNamedNode(t.predicate), termFromPatchObject(t.object, ambiguous), patchDefaultGraph()));
  }
}
