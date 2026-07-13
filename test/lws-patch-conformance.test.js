// test/lws-patch-conformance.test.js
// Review #7 (Solid #server-patch-n3-accept MUST) + P1 (LWS: JSON Merge Patch
// MUST, RFC 7386) + P2 (Solid #server-content-type-missing MUST).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as storage from '../src/storage/filesystem.js';
import { startTestServer, stopTestServer, request, createTestPod, getPodToken, getBaseUrl, assertStatus } from './helpers.js';

const N3_INSERT = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
_:p a solid:InsertDeletePatch;
  solid:inserts { <#s> <http://ex/q> "added". }.`;

test('N3 Patch on a verbatim-stored .ttl applies and stays Turtle (#7)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('patchttl');
  await request('/patchttl/d.ttl', { method: 'PUT', auth: 'patchttl',
    headers: { 'Content-Type': 'text/turtle' }, body: '<#s> <http://ex/p> "v".' });
  const r = await request('/patchttl/d.ttl', { method: 'PATCH', auth: 'patchttl',
    headers: { 'Content-Type': 'text/n3' }, body: N3_INSERT });
  assert.ok([200, 204].includes(r.status), `expected 2xx, got ${r.status}`);
  const back = await request('/patchttl/d.ttl', { headers: { Accept: 'text/turtle' }, auth: 'patchttl' });
  const ttl = await back.text();
  assert.match(ttl, /"v"/);        // original triple survives
  assert.match(ttl, /"added"/);    // patch applied
  assert.equal(back.headers.get('content-type').split(';')[0], 'text/turtle');  // stored format preserved
});

test('N3 Patch INSERT emits full predicate IRIs on a context-free stored doc (review #1)', async (t) => {
  // #7 projects verbatim-stored bytes through EXPANDED JSON-LD (no @context)
  // before applyN3Patch runs. insertTriple used to run the predicate through
  // compactPredicate unconditionally, producing keys like "rdf:type" that
  // re-parse (no @context to resolve them) as literal scheme-IRIs
  // <rdf:type> instead of the real vocabulary IRI.
  //
  // Storage format is deliberately application/n-triples, NOT text/turtle:
  // Turtle-family write-back declares the SAME 7 default prefixes
  // (COMMON_PREFIXES) that compactPredicate hardcodes, so a Turtle
  // round-trip coincidentally "launders" the corrupt CURIE-shaped string
  // back to the correct IRI on re-parse and hides the bug. N-Triples has no
  // prefix mechanism — a corrupt predicate stays a literal wrong IRI, which
  // is what makes this the right stored form to pin the regression against.
  // Assert TRIPLE-LEVEL via the n3 Parser — a regex/substring check would
  // miss this class of bug (and would be fooled by the Turtle-masking above).
  //
  // PUT itself doesn't accept application/n-triples (not in SUPPORTED_INPUT),
  // so the seed file is written directly via storage.write — the same
  // seeding pattern test/lws-serve-nt-nq.test.js and
  // test/lws-conditional-406.test.js use for filesystem/git-sourced .nt/.nq.
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('patchiris');
  await storage.write('/patchiris/d.nt', Buffer.from('<#s> <http://ex/p> "v" .\n'));
  const INSERT_COMMON = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
_:p a solid:InsertDeletePatch;
  solid:inserts {
    <#s> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://ex/Thing>.
    <#s> <http://purl.org/dc/terms/title> "Title".
  }.`;
  const r = await request('/patchiris/d.nt', { method: 'PATCH', auth: 'patchiris',
    headers: { 'Content-Type': 'text/n3' }, body: INSERT_COMMON });
  assert.ok([200, 204].includes(r.status), `expected 2xx, got ${r.status}`);

  const back = await request('/patchiris/d.nt', { headers: { Accept: 'application/n-triples' }, auth: 'patchiris' });
  const nt = await back.text();
  const { Parser } = await import('n3');
  const quads = new Parser({ baseIRI: new URL('/patchiris/d.nt', getBaseUrl()).href }).parse(nt);
  const predicates = quads.map(q => q.predicate.value);
  assert.ok(predicates.includes('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
    `expected the full rdf:type IRI among stored predicates, got ${JSON.stringify(predicates)}`);
  assert.ok(predicates.includes('http://purl.org/dc/terms/title'),
    `expected the full dc:title IRI among stored predicates, got ${JSON.stringify(predicates)}`);
});

test('N3 Patch DELETE removes a common-vocabulary triple on a context-free stored doc (review #1, symmetric)', async (t) => {
  // Pins the symmetric (delete-side) path: a genuine dc:title triple
  // (never touched by insertTriple's compaction) must still be matched
  // and removed by predicate on an expanded/context-free document.
  // application/n-triples again, so there is no prefix-declaration masking
  // to launder a match failure into an accidental pass. Seeded via
  // storage.write — see the note on the INSERT test above.
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('patchdelvoc');
  await storage.write('/patchdelvoc/d.nt', Buffer.from(
    '<#s> <http://ex/p> "v" .\n<#s> <http://purl.org/dc/terms/title> "Title" .\n'));
  const DELETE_COMMON = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
_:p a solid:InsertDeletePatch;
  solid:deletes { <#s> <http://purl.org/dc/terms/title> "Title". }.`;
  const r = await request('/patchdelvoc/d.nt', { method: 'PATCH', auth: 'patchdelvoc',
    headers: { 'Content-Type': 'text/n3' }, body: DELETE_COMMON });
  assert.ok([200, 204].includes(r.status), `expected 2xx, got ${r.status}`);

  const back = await request('/patchdelvoc/d.nt', { headers: { Accept: 'application/n-triples' }, auth: 'patchdelvoc' });
  const nt = await back.text();
  const { Parser } = await import('n3');
  const quads = new Parser({ baseIRI: new URL('/patchdelvoc/d.nt', getBaseUrl()).href }).parse(nt);
  const predicates = quads.map(q => q.predicate.value);
  assert.ok(!predicates.includes('http://purl.org/dc/terms/title'),
    `dc:title should have been deleted, got ${JSON.stringify(predicates)}`);
  assert.ok(predicates.includes('http://ex/p'), 'unrelated triple should survive the delete');
});

// Finding 1 (whole-branch review): parseSparqlUpdate KNOWS its bare-string
// objects are xsd:string literals (termToJsonLdValue flattens them that
// way deliberately) — that's a different shape-origin than N3-Patch's bare
// strings, which are GENUINELY ambiguous (IRI or literal, same shape) and
// need the http-heuristic. termFromPatchObject must not apply the
// heuristic to SPARQL-sourced bare strings, or a URL-valued string literal
// gets corrupted into a NamedNode on insert, and a DELETE targeting that
// same literal silently no-ops (deleteMatches against a NamedNode object
// never matches the stored Literal).
test('SPARQL INSERT DATA of a URL-valued string literal stores a LITERAL, not an IRI (finding 1)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('sparqllit');
  await request('/sparqllit/d.ttl', { method: 'PUT', auth: 'sparqllit',
    headers: { 'Content-Type': 'text/turtle' }, body: '<#s> <http://ex/p> "v".' });
  const INSERT = 'INSERT DATA { <#s> <http://ex/url> "https://example.org" . }';
  const r = await request('/sparqllit/d.ttl', { method: 'PATCH', auth: 'sparqllit',
    headers: { 'Content-Type': 'application/sparql-update' }, body: INSERT });
  assert.ok([200, 204].includes(r.status), `expected 2xx, got ${r.status}`);

  const back = await request('/sparqllit/d.ttl', { headers: { Accept: 'text/turtle' }, auth: 'sparqllit' });
  const ttl = await back.text();
  const { Parser } = await import('n3');
  const quads = new Parser({ baseIRI: new URL('/sparqllit/d.ttl', getBaseUrl()).href }).parse(ttl);
  const match = quads.find(q => q.predicate.value === 'http://ex/url');
  assert.ok(match, `expected a triple with predicate http://ex/url, got ${JSON.stringify(quads.map(q => q.predicate.value))}`);
  assert.equal(match.object.termType, 'Literal',
    `expected a Literal object, got ${match.object.termType} (value: ${match.object.value})`);
  assert.equal(match.object.value, 'https://example.org');
});

test('SPARQL DELETE DATA of a URL-valued string literal actually removes it (finding 1, silent no-op case)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('sparqldellit');
  await storage.write('/sparqldellit/d.ttl', Buffer.from(
    '<#s> <http://ex/url> "https://example.org" .\n<#s> <http://ex/p> "v" .\n'));
  const DELETE = 'DELETE DATA { <#s> <http://ex/url> "https://example.org" . }';
  const r = await request('/sparqldellit/d.ttl', { method: 'PATCH', auth: 'sparqldellit',
    headers: { 'Content-Type': 'application/sparql-update' }, body: DELETE });
  assert.ok([200, 204].includes(r.status), `expected 2xx, got ${r.status}`);

  const back = await request('/sparqldellit/d.ttl', { headers: { Accept: 'text/turtle' }, auth: 'sparqldellit' });
  const ttl = await back.text();
  const { Parser } = await import('n3');
  const quads = new Parser({ baseIRI: new URL('/sparqldellit/d.ttl', getBaseUrl()).href }).parse(ttl);
  const predicates = quads.map(q => q.predicate.value);
  assert.ok(!predicates.includes('http://ex/url'),
    `expected the http://ex/url triple to be deleted, got ${JSON.stringify(predicates)}`);
  assert.ok(predicates.includes('http://ex/p'), 'unrelated triple should survive the delete');
});

test('N3 Patch inserting an actual IRI object still stores an IRI (finding 1, regression guard)', async (t) => {
  // N3-Patch's own parser returns a bare string for BOTH IRI and
  // plain-literal objects (genuine ambiguity, unlike SPARQL above) — the
  // http-heuristic must still apply to N3-Patch-sourced objects.
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('n3iriguard');
  await request('/n3iriguard/d.ttl', { method: 'PUT', auth: 'n3iriguard',
    headers: { 'Content-Type': 'text/turtle' }, body: '<#s> <http://ex/p> "v".' });
  const INSERT = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
_:p a solid:InsertDeletePatch;
  solid:inserts { <#s> <http://ex/url> <https://example.org>. }.`;
  const r = await request('/n3iriguard/d.ttl', { method: 'PATCH', auth: 'n3iriguard',
    headers: { 'Content-Type': 'text/n3' }, body: INSERT });
  assert.ok([200, 204].includes(r.status), `expected 2xx, got ${r.status}`);

  const back = await request('/n3iriguard/d.ttl', { headers: { Accept: 'text/turtle' }, auth: 'n3iriguard' });
  const ttl = await back.text();
  const { Parser } = await import('n3');
  const quads = new Parser({ baseIRI: new URL('/n3iriguard/d.ttl', getBaseUrl()).href }).parse(ttl);
  const match = quads.find(q => q.predicate.value === 'http://ex/url');
  assert.ok(match, `expected a triple with predicate http://ex/url, got ${JSON.stringify(quads.map(q => q.predicate.value))}`);
  assert.equal(match.object.termType, 'NamedNode',
    `expected a NamedNode object (N3-Patch's ambiguous heuristic), got ${match.object.termType}`);
  assert.equal(match.object.value, 'https://example.org');
});

test('JSON Merge Patch applies to a stored JSON-LD doc (P1, RFC 7386)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('mergep');
  await request('/mergep/d.jsonld', { method: 'PUT', auth: 'mergep',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify({ '@context': { ex: 'http://ex/' }, '@id': '#it', 'ex:a': 'keep', 'ex:b': 'drop' }) });
  const r = await request('/mergep/d.jsonld', { method: 'PATCH', auth: 'mergep',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body: JSON.stringify({ 'ex:b': null, 'ex:c': 'new' }) });
  assert.ok([200, 204].includes(r.status), `expected 2xx, got ${r.status}`);
  const back = JSON.parse(await (await request('/mergep/d.jsonld', { auth: 'mergep' })).text());
  assert.equal(back['ex:a'], 'keep');
  assert.equal('ex:b' in back, false);
  assert.equal(back['ex:c'], 'new');
});

test('merge-patch on a Turtle-stored doc 415s with teaching (P1 scope)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('mergettl');
  await request('/mergettl/d.ttl', { method: 'PUT', auth: 'mergettl',
    headers: { 'Content-Type': 'text/turtle' }, body: '<#s> <http://ex/p> "v".' });
  const r = await request('/mergettl/d.ttl', { method: 'PATCH', auth: 'mergettl',
    headers: { 'Content-Type': 'application/merge-patch+json' }, body: JSON.stringify({ 'ex:b': 'x' }) });
  assertStatus(r, 415);
  const problem = await r.json();
  assert.match(JSON.stringify(problem), /text\/turtle/);
});

test('Accept-Patch advertises merge-patch under --lws', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('acceptpatch');
  await request('/acceptpatch/d.ttl', { method: 'PUT', auth: 'acceptpatch',
    headers: { 'Content-Type': 'text/turtle' }, body: '<#s> <http://ex/p> "v".' });
  const r = await request('/acceptpatch/d.ttl', { method: 'OPTIONS', auth: 'acceptpatch' });
  const acceptPatch = r.headers.get('accept-patch') || '';
  assert.match(acceptPatch, /text\/n3/);
  assert.match(acceptPatch, /application\/merge-patch\+json/);
});

test('Accept-Patch stays byte-identical without --lws', async (t) => {
  await startTestServer({ conneg: true });
  t.after(stopTestServer);
  await createTestPod('noLws');
  await request('/noLws/d.ttl', { method: 'PUT', auth: 'noLws',
    headers: { 'Content-Type': 'text/turtle' }, body: '<#s> <http://ex/p> "v".' });
  const r = await request('/noLws/d.ttl', { method: 'OPTIONS', auth: 'noLws' });
  assert.equal(r.headers.get('accept-patch'), 'text/n3, application/sparql-update');
});

test('PATCH 415 message stays byte-identical without --lws (review #2)', async (t) => {
  await startTestServer({ conneg: true });
  t.after(stopTestServer);
  await createTestPod('patch415off');
  await request('/patch415off/d.ttl', { method: 'PUT', auth: 'patch415off',
    headers: { 'Content-Type': 'text/turtle' }, body: '<#s> <http://ex/p> "v".' });
  const r = await request('/patch415off/d.ttl', { method: 'PATCH', auth: 'patch415off',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'add' }) });
  assertStatus(r, 415);
  const body = await r.json();
  assert.deepEqual(body, {
    error: 'Unsupported Media Type',
    message: 'PATCH requires Content-Type: text/n3 (N3 Patch) or application/sparql-update (SPARQL Update)'
  });
});

// Raw socket helper: fetch/undici auto-derives a Content-Type for string
// bodies, so a genuinely absent header needs a hand-rolled HTTP/1.1 request.
function rawRequest({ port, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('bodied PUT/POST/PATCH without Content-Type -> 400 (P2)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('noct');
  const tok = getPodToken('noct');
  const port = new URL(getBaseUrl()).port;

  const put = await rawRequest({
    port, method: 'PUT', path: '/noct/x.bin',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Length': Buffer.byteLength('some bytes') },
    body: 'some bytes',
  });
  assert.equal(put.status, 400, `PUT: expected 400, got ${put.status} (body: ${put.body})`);

  const post = await rawRequest({
    port, method: 'POST', path: '/noct/',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Length': Buffer.byteLength('some bytes') },
    body: 'some bytes',
  });
  assert.equal(post.status, 400, `POST: expected 400, got ${post.status} (body: ${post.body})`);

  // PATCH needs an existing resource to target; content-type absence must still 400 first.
  await request('/noct/p.ttl', { method: 'PUT', auth: 'noct',
    headers: { 'Content-Type': 'text/turtle' }, body: '<#s> <http://ex/p> "v".' });
  const patch = await rawRequest({
    port, method: 'PATCH', path: '/noct/p.ttl',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Length': Buffer.byteLength(N3_INSERT) },
    body: N3_INSERT,
  });
  assert.equal(patch.status, 400, `PATCH: expected 400, got ${patch.status} (body: ${patch.body})`);
});
