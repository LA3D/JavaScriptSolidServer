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
});
