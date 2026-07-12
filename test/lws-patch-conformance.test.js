// test/lws-patch-conformance.test.js
// Review #7 (Solid #server-patch-n3-accept MUST) + P1 (LWS: JSON Merge Patch
// MUST, RFC 7386) + P2 (Solid #server-content-type-missing MUST).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
