// test/rdf-serve.test.js
// The --lws serving arm's policy engine (spec 2026-07-10 §2): real parser +
// n3 writer; lossy or failed conversions refuse with a teaching 406 payload —
// never a silent 200 with empty or mislabeled bytes (the probe-#4 family).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveStoredRdf, checkServable, QUADS_OUTPUTS } from '../src/rdf/serve.js';
import { selectContentType, RDF_TYPES } from '../src/rdf/conneg.js';

const BASE = 'https://pod.example/x';
const buf = (o) => Buffer.from(JSON.stringify(o));

test('RDF_TYPES.NQUADS exists and n-quads negotiates only under lws+conneg', () => {
  assert.equal(RDF_TYPES.NQUADS, 'application/n-quads');
  assert.equal(selectContentType('application/n-quads', true, true), RDF_TYPES.NQUADS);
  assert.equal(selectContentType('application/n-quads', true, false), RDF_TYPES.JSON_LD);
  assert.equal(selectContentType('application/n-quads', false, true), RDF_TYPES.JSON_LD);
  assert.equal(selectContentType('application/n-triples', true, true), RDF_TYPES.NTRIPLES);
  // pre-existing behavior untouched
  assert.equal(selectContentType('text/turtle', true), RDF_TYPES.TURTLE);
});

test('serveStoredRdf: {@context,@graph} doc → real Turtle triples (probe-#4 dead)', async () => {
  const doc = { '@context': { name: 'https://schema.org/name' }, '@graph': [
    { '@id': `${BASE}#a`, name: 'A' }, { '@id': `${BASE}#b`, name: 'B' }] };
  const r = await serveStoredRdf({ bytes: buf(doc), targetType: RDF_TYPES.TURTLE, baseIri: BASE });
  assert.equal(r.ok, true);
  assert.equal(r.contentType, RDF_TYPES.TURTLE);
  assert.match(r.content, /"A"/);
  assert.match(r.content, /"B"/);
});

test('serveStoredRdf: named graphs → Turtle & N-Triples 406 teaching; N-Quads 200 lossless', async () => {
  const doc = { '@context': { name: 'https://schema.org/name' }, '@id': `${BASE}#g1`, '@graph': [
    { '@id': `${BASE}#a`, name: 'A' }] };
  for (const t of [RDF_TYPES.TURTLE, RDF_TYPES.NTRIPLES]) {
    const r = await serveStoredRdf({ bytes: buf(doc), targetType: t, baseIri: BASE });
    assert.equal(r.ok, false);
    assert.equal(r.status, 406);
    assert.match(r.problem.detail, /named graphs/);
    assert.match(r.problem.detail, /application\/n-quads/);
  }
  const nq = await serveStoredRdf({ bytes: buf(doc), targetType: RDF_TYPES.NQUADS, baseIri: BASE });
  assert.equal(nq.ok, true);
  assert.match(nq.content, /#g1>/);          // graph term survives — lossless
});

test('serveStoredRdf: remote @context → 406 teaching (offline loader), never empty output', async () => {
  const doc = { '@context': 'https://schema.org', '@id': `${BASE}#a`, name: 'A' };
  const r = await serveStoredRdf({ bytes: buf(doc), targetType: RDF_TYPES.TURTLE, baseIri: BASE });
  assert.equal(r.ok, false);
  assert.equal(r.status, 406);
  assert.match(r.problem.detail, /remote @context/);
  assert.match(r.problem.detail, /application\/ld\+json/);
});

test('checkServable mirrors the policy without serializing (HEAD parity)', async () => {
  const named = { '@context': { name: 'https://schema.org/name' }, '@id': `${BASE}#g1`, '@graph': [{ '@id': `${BASE}#a`, name: 'A' }] };
  assert.equal((await checkServable({ bytes: buf(named), targetType: RDF_TYPES.TURTLE, baseIri: BASE })).ok, false);
  assert.equal((await checkServable({ bytes: buf(named), targetType: RDF_TYPES.NQUADS, baseIri: BASE })).ok, true);
});

test('QUADS_OUTPUTS maps text/n3 to Turtle (existing N3-serves-Turtle behavior)', () => {
  assert.equal(QUADS_OUTPUTS[RDF_TYPES.N3], RDF_TYPES.TURTLE);
  assert.equal(QUADS_OUTPUTS[RDF_TYPES.JSON_LD], undefined);
});

test('serveStoredRdf: empty body → 406 whose detail states the real cause, no remote-@context claim', async () => {
  const r = await serveStoredRdf({ bytes: Buffer.from(''), targetType: RDF_TYPES.TURTLE, baseIri: BASE });
  assert.equal(r.ok, false);
  assert.equal(r.status, 406);
  assert.match(r.problem.detail, /empty JSON-LD body/);
  assert.ok(!r.problem.detail.includes('remote @context'));
});

test('serveStoredRdf: malformed JSON → 406 stating the parse error, no remote-@context claim', async () => {
  const r = await serveStoredRdf({ bytes: Buffer.from('{not json'), targetType: RDF_TYPES.TURTLE, baseIri: BASE });
  assert.equal(r.ok, false);
  assert.ok(!r.problem.detail.includes('remote @context'));
});
