// test/lws-media-type-label.test.js
// P3 (LWS media-type MUST — FOLLOWUP.md conformance-audit 2026-07-12): a
// container representation requested as application/lws+json, application/
// ld+json, or application/json gets the SAME JSON-LD payload back under the
// Content-Type LABEL the client asked for. selectContentType fell through
// application/json to ld+json (resource.js listing branch had no
// application/json arm) — body identity held, only the label lied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, assertStatus } from './helpers.js';

test('the three JSON labels on a container: identical payload, correct labels, distinct ETags', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('label');
  const get = (accept) => request('/label/', { headers: { Accept: accept }, auth: 'label' });
  const [lws, ld, plain] = await Promise.all([
    get('application/lws+json'), get('application/ld+json'), get('application/json')]);
  for (const r of [lws, ld, plain]) assertStatus(r, 200);
  assert.equal(lws.headers.get('content-type').split(';')[0], 'application/lws+json');
  assert.equal(ld.headers.get('content-type').split(';')[0], 'application/ld+json');
  assert.equal(plain.headers.get('content-type').split(';')[0], 'application/json');
  assert.deepEqual(JSON.parse(await plain.text()), JSON.parse(await ld.text()));   // payload identity
  assert.notEqual(plain.headers.get('etag'), ld.headers.get('etag'));              // RFC 9110 §8.8.3
});

test('HEAD mirrors the application/json label', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('labelhead');
  const get = await request('/labelhead/', { headers: { Accept: 'application/json' }, auth: 'labelhead' });
  const head = await request('/labelhead/', { method: 'HEAD', headers: { Accept: 'application/json' }, auth: 'labelhead' });
  assertStatus(get, 200);
  assertStatus(head, 200);
  assert.equal(head.headers.get('content-type').split(';')[0], 'application/json');
  assert.equal(head.headers.get('etag'), get.headers.get('etag'));   // HEAD/GET parity (#552)
});

test('explicit ld+json outranking json keeps ld+json', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('labelq');
  const r = await request('/labelq/', {
    headers: { Accept: 'application/ld+json, application/json;q=0.5' }, auth: 'labelq' });
  assertStatus(r, 200);
  assert.equal(r.headers.get('content-type').split(';')[0], 'application/ld+json');
});

test('storage description honors the three labels too (fix only if red)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  const get = (accept) => request('/.well-known/lws-storage', { headers: { Accept: accept } });
  const [lws, ld, plain] = await Promise.all([
    get('application/lws+json'), get('application/ld+json'), get('application/json')]);
  for (const r of [lws, ld, plain]) assertStatus(r, 200);
  assert.equal(lws.headers.get('content-type').split(';')[0], 'application/lws+json');
  assert.equal(ld.headers.get('content-type').split(';')[0], 'application/ld+json');
  assert.equal(plain.headers.get('content-type').split(';')[0], 'application/json');
  const [lwsBody, ldBody, plainBody] = await Promise.all([lws.json(), ld.json(), plain.json()]);
  assert.deepEqual(plainBody, ldBody);   // payload identity, same rigor as Test 1
  assert.deepEqual(lwsBody, ldBody);
});

// Task-9 review finding: GET has a SEPARATE branch (resource.js's
// index.html-shadow leg) that extracts a JSON-LD data island from an
// index.html and serves it directly — the P3 swap above only ever touched
// the container-LISTING branch (no index.html) and the HEAD shadow branch,
// so a shadowed container's GET/HEAD DISAGREED on the label for the exact
// same request (#552). The seeded server root always ships an index.html,
// so this is live on a default `GET /`.
test('shadowed container (index.html data-island): GET/HEAD label parity + payload identity (#552)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('shadow');
  const island = { '@context': { foaf: 'http://xmlns.com/foaf/0.1/' }, '@id': '#me', 'foaf:name': 'Shadow' };
  const html = '<!doctype html><html><head><title>Home</title>'
    + `<script type="application/ld+json">${JSON.stringify(island)}</script>`
    + '</head><body><h1>hi</h1></body></html>';
  await request('/shadow/index.html', {
    method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'shadow', body: html,
  });

  const defaultAccept = 'application/json, */*';
  const get = await request('/shadow/', { headers: { Accept: defaultAccept }, auth: 'shadow' });
  const head = await request('/shadow/', { method: 'HEAD', headers: { Accept: defaultAccept }, auth: 'shadow' });
  // A2 (spec 2026-07-11 §4): under --lws, the shadow only stays active for
  // Accepts that can also take HTML — a bare 'application/ld+json' (no
  // */* or text/html) ESCAPES the shadow entirely and hits the real
  // container-listing branch instead, not the island this test targets.
  // Keep a low-q */* so the island stays reachable while ld+json still
  // wins the label.
  const getLd = await request('/shadow/', { headers: { Accept: 'application/ld+json, */*;q=0.1' }, auth: 'shadow' });
  assertStatus(get, 200);
  assertStatus(head, 200);
  assertStatus(getLd, 200);

  assert.equal(get.headers.get('content-type').split(';')[0], 'application/json',
    'default-Accept GET of a shadowed container must label the island application/json');
  assert.equal(head.headers.get('content-type').split(';')[0], get.headers.get('content-type').split(';')[0],
    'HEAD must mirror GET\'s label (#552)');
  assert.equal(head.headers.get('etag'), get.headers.get('etag'), 'HEAD/GET ETag parity (#552)');
  assert.deepEqual(JSON.parse(await get.text()), await getLd.json());   // payload identity, label-only swap

  const getQ = await request('/shadow/', {
    headers: { Accept: 'application/ld+json, application/json;q=0.5, */*;q=0.1' }, auth: 'shadow' });
  assertStatus(getQ, 200);
  assert.equal(getQ.headers.get('content-type').split(';')[0], 'application/ld+json',
    'explicit ld+json outranking json must still win on the shadowed island');
});
