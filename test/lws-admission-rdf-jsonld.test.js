// Real-JSON-LD parsing through the toDataset seam (@rdfjs/parser-jsonld swap).
// Pins the forms the hand-rolled bridge silently dropped: array @context,
// term aliases, @graph — and the fail-LOUD stance on remote @context (no-network
// documentLoader, LWS v1 preloaded from the pod's own mirror).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDataset } from '../src/rdf/dataset.js';
import { readRepresentations } from '../src/lws/representations.js';
import { admit } from '../src/lws/admission.js';

const RES = 'https://pod.example/alice/mem-a';
const LINKS = 'https://pod.example/alice/mem-a.links.jsonld';
const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';

const buf = (o) => Buffer.from(JSON.stringify(o), 'utf8');
const preds = (ds) => new Set([...ds].map((q) => q.predicate.value));

test('toDataset: array @context expands prefixed keys', async () => {
  const ds = await toDataset(buf({
    '@context': [{ altr: ALTR }, { dct: DCT }],
    '@id': RES,
    'altr:hasRepresentation': { '@id': LINKS, 'dct:format': 'application/ld+json' },
  }), 'application/ld+json', RES);
  assert.ok(preds(ds).has(ALTR + 'hasRepresentation'), 'altr: prefix expanded from array context');
  assert.ok(preds(ds).has(DCT + 'format'), 'dct: prefix expanded from array context');
});

test('toDataset: term-alias @context expands', async () => {
  const ds = await toDataset(buf({
    '@context': { hasRepresentation: ALTR + 'hasRepresentation', format: DCT + 'format' },
    '@id': RES,
    hasRepresentation: { '@id': LINKS, format: 'application/ld+json' },
  }), 'application/ld+json', RES);
  assert.ok(preds(ds).has(ALTR + 'hasRepresentation'));
});

test('toDataset: @graph contents produce quads (admission un-blinded)', async () => {
  const ds = await toDataset(buf({
    '@context': { dct: DCT },
    '@id': RES,
    '@graph': [{ '@id': RES + '#it', 'dct:title': 'X' }],
  }), 'application/ld+json', RES);
  assert.ok(ds.size >= 1, '@graph contents parsed (bridge produced 0)');
  assert.ok(preds(ds).has(DCT + 'title'));
});

test('toDataset: unknown remote @context throws (fail loud, no fetch)', async () => {
  await assert.rejects(
    toDataset(buf({
      '@context': 'https://example.org/ctx.jsonld',
      '@id': RES, name: 'x',
    }), 'application/ld+json', RES),
    /remote @context fetch disabled|Failed to load remote context/i
  );
});

test('toDataset: LWS v1 context resolves from the preloaded mirror', async () => {
  const ds = await toDataset(buf({
    '@context': 'https://www.w3.org/ns/lws/v1',
    id: RES, type: 'Container',
  }), 'application/ld+json', RES);
  const types = [...ds].filter((q) => q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  assert.equal(types[0]?.object.value, 'https://www.w3.org/ns/lws#Container', 'lws terms expand via the mirror');
});

test('toDataset: turtle arm unchanged', async () => {
  const ds = await toDataset(Buffer.from(`<${RES}> <${DCT}title> "X" .`, 'utf8'), 'text/turtle', RES);
  assert.equal(ds.size, 1);
});

test('readRepresentations: array-@context .meta is SEEN (the silent-inert bug)', async () => {
  const meta = {
    '@context': [{ altr: ALTR }, { dct: DCT }],
    '@id': RES,
    'altr:hasDefaultRepresentation': { '@id': RES, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': 'https://p/content' } },
    'altr:hasRepresentation': { '@id': LINKS, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': 'https://p/links' } },
  };
  const storage = { async exists() { return true; }, async read() { return buf(meta); } };
  const reps = await readRepresentations(storage, RES + '.meta', RES);
  assert.equal(reps.default?.profile, 'https://p/content');
  assert.equal(reps.alternates.length, 1);
  assert.equal(reps.alternates[0].href, LINKS);
});

// --- admission behavior on the new fail-loud parser ---

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';
const SHAPE_URL = 'https://pod.example/alice/shapes/S';
const SHAPE_TTL = `@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix dct: <${DCT}> .
<${SHAPE_URL}#N> a sh:NodeShape ; sh:targetClass <https://ex.org/T> ;
  sh:property [ sh:path dct:title ; sh:minCount 1 ; sh:severity sh:Violation ] .`;

function admissionStorage({ shapeBytes }) {
  const meta = buf({ '@id': RES, [DESCRIBEDBY]: { '@id': SHAPE_URL } });
  return {
    async exists(p) { return p === RES + '.meta' || p === '/alice/shapes/S'; },
    async read(p) {
      if (p === RES + '.meta') return meta;
      if (p === '/alice/shapes/S') return shapeBytes;
      throw new Error('ENOENT ' + p);
    },
  };
}

test('admit: unparseable governed body → reject with teaching violation (400, not 500)', async () => {
  const storage = admissionStorage({ shapeBytes: Buffer.from(SHAPE_TTL, 'utf8') });
  const r = await admit({
    storage,
    content: buf({ '@context': 'https://example.org/nope.jsonld', '@id': RES + '#it', '@type': 'https://ex.org/T' }),
    contentType: 'application/ld+json',
    resourceUrl: RES,
    targetMetaPath: RES + '.meta',
    containerMetaPath: '/alice/.meta',
    shapeUrlToPath: () => '/alice/shapes/S',
  });
  assert.equal(r.decision, 'reject');
  assert.equal(r.violations.length, 1);
  assert.match(r.violations[0].message, /JSON-LD|context|parse/i);
});

test('admit: corrupt declared shape degrades to pass (missing-shape precedent)', async () => {
  const storage = admissionStorage({ shapeBytes: Buffer.from('{ this is not json-ld', 'utf8') });
  const r = await admit({
    storage,
    content: buf({ '@id': RES + '#it', '@type': 'https://ex.org/T' }),
    contentType: 'application/ld+json',
    resourceUrl: RES,
    targetMetaPath: RES + '.meta',
    containerMetaPath: '/alice/.meta',
    shapeUrlToPath: () => '/alice/shapes/S',
  });
  assert.equal(r.decision, 'pass');
});

test('toDataset: JSS legacy store-array (context on element 0 only) — restriction now ORPHANS under standard JSON-LD (shim removed, spec 2026-07-10 §3)', async () => {
  // JSS's own toJsonLd store format: top-level array, @context only on [0].
  // The shim that hoisted element 0's context onto elements 1..n is retired —
  // a top-level array is standard JSON-LD now (decision log #3). Elements
  // without their own @context get NO prefix expansion: sh:path/sh:minCount
  // stay literal scheme-'sh:' predicates, not the SHACL namespace. Fixing the
  // store form itself is a later serializer-round task; this seam no longer
  // papers over it.
  const SH = 'http://www.w3.org/ns/shacl#';
  const stored = [
    { '@context': { sh: SH, ex: 'http://ex.org/' },
      '@id': 'http://ex.org/NoteShape', '@type': 'sh:NodeShape',
      'sh:property': { '@id': '_:n3-0' } },
    { '@id': '_:n3-0', 'sh:path': { '@id': 'http://ex.org/title' }, 'sh:minCount': 1 },
  ];
  const ds = await toDataset(buf(stored), 'application/ld+json', 'http://h/shapes/X');
  const ps = preds(ds);
  assert.ok(ps.has(SH + 'property'), 'element 0 still expands via its own @context');
  assert.ok(!ps.has(SH + 'path'), 'sh:path on element 1 no longer expands — no hoisted context');
  assert.ok(!ps.has(SH + 'minCount'), 'sh:minCount on element 1 no longer expands');
  assert.ok(ps.has('sh:path'), 'unresolved compact IRI kept literal, per standard JSON-LD IRI expansion');
});

test('toDataset: array element with its OWN @context keeps it (shim never overwrites)', async () => {
  const stored = [
    { '@context': { a: 'http://a.example/' }, '@id': 'http://x/1', 'a:p': 'v1' },
    { '@context': { a: 'http://b.example/' }, '@id': 'http://x/2', 'a:p': 'v2' },
  ];
  const ds = await toDataset(buf(stored), 'application/ld+json', 'http://x/');
  const ps = preds(ds);
  assert.ok(ps.has('http://a.example/p'));
  assert.ok(ps.has('http://b.example/p'), 'second element used ITS context, not element 0’s');
});
