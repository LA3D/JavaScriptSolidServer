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
// they survive untouched. The N3-Patch conformance contracts (deletes MUST
// exist; a non-empty solid:where binds a single solution) are enforced by
// patchDeletesExist / resolveWhere below, which the handler runs BEFORE this
// applier — so this stays the pure, unconditional term-level write.
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

// --- N3-Patch conformance (Task 8) -----------------------------------------
// Solid N3 Patch (https://solid.github.io/specification/protocol#n3-patch)
// imposes two contracts the unconditional applier above does NOT honor:
//   1. every triple in solid:deletes MUST already exist in the target graph —
//      a delete of an absent triple is a 409 Conflict, not a silent no-op.
//   2. a non-empty solid:where is a query whose SINGLE solution binds the
//      variables in deletes/inserts; zero or multiple solutions → 409.
// patchDeletesExist enforces (1); resolveWhere enforces (2). Both read the
// same rdf-ext dataset the term-level applier writes to, reusing the term
// helpers above. SPARQL Update has no MUST-exist / single-solution contract,
// so only the N3-Patch caller runs these (SPARQL deletes stay best-effort).

const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

const isVar = t => t && typeof t === 'object' && t.variable !== undefined;

// A patch-triple position (string / flexible-object / {variable}) → an rdf
// term for dataset.match, or undefined (wildcard) for a not-yet-bound
// variable. `bound` carries variables already fixed by earlier where patterns.
function matchTerm(pos, kind, bound, ambiguous) {
  if (isVar(pos)) return bound[pos.variable];              // bound term, or undefined = wildcard
  if (kind === 's') return termFromId(pos);
  if (kind === 'p') return patchNamedNode(pos);
  return termFromPatchObject(pos, ambiguous);
}

// Contract 1: every delete triple must match something. {ok} | {ok:false, missing}.
export function patchDeletesExist(dataset, { deletes = [] }, ambiguous) {
  for (const t of deletes) {
    const m = dataset.match(
      termFromId(t.subject), patchNamedNode(t.predicate),
      termFromPatchObject(t.object, ambiguous), patchDefaultGraph());
    if (m.size === 0) return { ok: false, missing: t };
  }
  return { ok: true };
}

// Evaluate the solid:where BGP against the DEFAULT graph as a nested-loop
// join: each pattern extends the running solution set — a variable already
// bound by an earlier pattern is substituted into the match (keeping the join
// consistent), a fresh variable is bound from each matching quad, and a
// variable repeated within one pattern is checked for agreement. Returns an
// array of binding maps {varName: rdfTerm}.
function evalWhere(dataset, where, ambiguous) {
  let solutions = [Object.create(null)];
  for (const pat of where) {
    const next = [];
    for (const bound of solutions) {
      const m = dataset.match(
        matchTerm(pat.subject, 's', bound, ambiguous),
        matchTerm(pat.predicate, 'p', bound, ambiguous),
        matchTerm(pat.object, 'o', bound, ambiguous),
        patchDefaultGraph());
      for (const q of m) {
        const nb = Object.assign(Object.create(null), bound);
        let ok = true;
        for (const [p, term] of [[pat.subject, q.subject], [pat.predicate, q.predicate], [pat.object, q.object]]) {
          if (!isVar(p)) continue;
          if (nb[p.variable] !== undefined && !nb[p.variable].equals(term)) { ok = false; break; }
          nb[p.variable] = term;
        }
        if (ok) next.push(nb);
      }
    }
    solutions = next;
    if (solutions.length === 0) break;    // an empty set can't be revived by a later join
  }
  return solutions;
}

// rdf term → patch-triple object-position shape (precise — no http-heuristic,
// so a URL-valued literal stays a literal). termFromPatchObject reads it back.
function objShape(term) {
  if (term.termType === 'NamedNode') return { '@id': term.value };
  if (term.termType === 'BlankNode') return { blankNode: term.value };
  if (term.language) return { value: term.value, language: term.language };
  const dt = term.datatype && term.datatype.value;
  return (dt && dt !== XSD_STRING && dt !== RDF_LANG_STRING)
    ? { value: term.value, type: dt }
    : { value: term.value };
}
// rdf term → subject-position string (IRI or _:bnode); termFromId reads it back.
const subjShape = term => term.termType === 'BlankNode' ? '_:' + term.value : term.value;

// Substitute one where solution into a delete/insert triple. Throws if a
// variable there was not bound by the where (malformed patch → caller → 409).
function subst(t, bound) {
  const one = (pos, to) => {
    if (!isVar(pos)) return pos;
    const term = bound[pos.variable];
    if (term === undefined) throw new Error(`unbound variable ?${pos.variable} in deletes/inserts`);
    return to(term);
  };
  return {
    subject: one(t.subject, subjShape),
    predicate: one(t.predicate, term => term.value),
    object: one(t.object, objShape),
  };
}

// Contract 2: bind the non-empty where, require exactly one solution, and
// substitute it into deletes/inserts. {ok:true, deletes, inserts} | {ok:false, detail}.
export function resolveWhere(dataset, patch, ambiguous) {
  let solutions;
  try {
    solutions = evalWhere(dataset, patch.where || [], ambiguous);
  } catch (e) {
    return { ok: false, detail: `solid:where could not be evaluated: ${e.message}` };
  }
  if (solutions.length === 0)
    return { ok: false, detail: 'solid:where matched no solution in the target graph; the conditional patch does not apply.' };
  if (solutions.length > 1)
    return { ok: false, detail: `solid:where matched ${solutions.length} solutions; N3 Patch requires exactly one.` };
  try {
    return {
      ok: true,
      deletes: (patch.deletes || []).map(t => subst(t, solutions[0])),
      inserts: (patch.inserts || []).map(t => subst(t, solutions[0])),
    };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}
