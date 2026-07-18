// R3/R4 (matrix 2026-07-18): generated LWS documents are GET/HEAD responses too —
// blanket "ETags MUST be provided in all GET/HEAD responses" + If-None-Match 304.
// Bodies are requester-dependent (WAC-filtered roster / 401-gated description),
// hence Vary: Authorization; media-type label conneg hence Vary: Accept.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, createTestPod } from './helpers.js';

let baseUrl;
before(async () => {
  ({ baseUrl } = await startTestServer({ lws: true }));
  await createTestPod('testpod');
});
after(async () => { await stopTestServer(); });

test('/.well-known/lws-storage: ETag + 304 + Vary', async () => {
  const r1 = await fetch(`${baseUrl}/.well-known/lws-storage`);
  assert.equal(r1.status, 200);
  const etag = r1.headers.get('etag');
  assert.ok(etag, 'ETag present');
  assert.match(r1.headers.get('vary') || '', /Authorization/);
  const r2 = await fetch(`${baseUrl}/.well-known/lws-storage`, { headers: { 'If-None-Match': etag } });
  assert.equal(r2.status, 304);
  assert.equal(r2.headers.get('etag'), etag);   // 304 carries the ETag (RFC 9110)
});

test('/:pod/lws-storage: ETag + 304; HEAD shares headers', async () => {
  const r1 = await fetch(`${baseUrl}/testpod/lws-storage`);
  assert.equal(r1.status, 200);
  const etag = r1.headers.get('etag');
  assert.ok(etag);
  const r304 = await fetch(`${baseUrl}/testpod/lws-storage`, { headers: { 'If-None-Match': etag } });
  assert.equal(r304.status, 304);
  const h = await fetch(`${baseUrl}/testpod/lws-storage`, { method: 'HEAD' });
  assert.equal(h.headers.get('etag'), etag);    // Fastify auto-HEAD runs the GET handler
});

test('mismatched If-None-Match still 200', async () => {
  const r = await fetch(`${baseUrl}/testpod/lws-storage`, { headers: { 'If-None-Match': '"nope"' } });
  assert.equal(r.status, 200);
});
