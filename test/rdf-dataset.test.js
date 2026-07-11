// test/rdf-dataset.test.js
// The shared bytes→dataset seam (src/rdf/dataset.js), promoted from
// src/lws/admission-rdf.js in the serving-path round with the legacy
// store-array shim REMOVED: a top-level array is standard JSON-LD now —
// elements without their own @context get no prefix expansion
// (spec 2026-07-10 §3, decision log #3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDataset, isRdfBody } from '../src/rdf/dataset.js';

const BASE = 'https://pod.example/x';

test('toDataset: {@context,@graph} JSON-LD parses to quads', async () => {
  const doc = { '@context': { name: 'https://schema.org/name' }, '@graph': [
    { '@id': `${BASE}#a`, name: 'A' }, { '@id': `${BASE}#b`, name: 'B' }] };
  const ds = await toDataset(Buffer.from(JSON.stringify(doc)), 'application/ld+json', BASE);
  assert.equal(ds.size, 2);
});

test('toDataset: legacy store array (context on element 0 only) is standard JSON-LD — no cross-element context bleed', async () => {
  const doc = [
    { '@context': { name: 'https://schema.org/name' }, '@id': `${BASE}#a`, name: 'A' },
    { '@id': `${BASE}#b`, name: 'B' },        // no @context: `name` must NOT expand
  ];
  const ds = await toDataset(Buffer.from(JSON.stringify(doc)), 'application/ld+json', BASE);
  const preds = [...ds].map(q => q.predicate.value).filter(p => p === 'https://schema.org/name');
  assert.equal(preds.length, 1);              // element 0 only — shim behavior is GONE
});

test('toDataset: Turtle arm unchanged', async () => {
  const ds = await toDataset(Buffer.from(`<${BASE}#a> <https://schema.org/name> "A".`), 'text/turtle', BASE);
  assert.equal(ds.size, 1);
});

test('toDataset: empty/whitespace JSON-LD body THROWS (fail loud — never a vacuous empty dataset)', async () => {
  await assert.rejects(() => toDataset(Buffer.from(''), 'application/ld+json', BASE));
  await assert.rejects(() => toDataset(Buffer.from('  \n'), 'application/ld+json', BASE));
});

test('isRdfBody: RDF media types recognized', () => {
  assert.equal(isRdfBody('application/ld+json; charset=utf-8'), true);
  assert.equal(isRdfBody('image/png'), false);
});
