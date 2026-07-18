// R3/R5 sweep for the remaining generated GET surfaces. The linkset gate (R5:
// update-resource.md L45 MUST) is expected to pass already (variant key 'ls') —
// it LOCKS existing behavior; the /types gates drive new ETags.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, createTestPod } from './helpers.js';

let baseUrl;
before(async () => {
  ({ baseUrl } = await startTestServer({ lws: true, lwsTypeIndex: true }));
  const pod = await createTestPod('testpod');
  // /public/ is the container with default (inherited) public-read ACL — the
  // pod root itself is public-read but does NOT propagate that to children
  // (see generateOwnerAcl: "children don't inherit public read"), so the
  // anonymous fetches below need the resource under /public/.
  const put = await fetch(`${baseUrl}/testpod/public/hello.txt`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${pod.token}` },
    body: 'hello',
  });
  assert.equal(put.status, 201);
});
after(async () => { await stopTestServer(); });

test('linkset GET carries an ETag distinct from the base representation (R5 lock)', async () => {
  const url = `${baseUrl}/testpod/public/hello.txt`;
  const base = await fetch(url);
  const ls = await fetch(url, { headers: { Accept: 'application/linkset+json' } });
  assert.equal(base.status, 200);
  assert.equal(ls.status, 200);
  assert.ok(ls.headers.get('etag'), 'linkset ETag present');
  assert.notEqual(ls.headers.get('etag'), base.headers.get('etag'));
  const lsHead = await fetch(url, { method: 'HEAD', headers: { Accept: 'application/linkset+json' } });
  assert.equal(lsHead.headers.get('etag'), ls.headers.get('etag'));
});

test('/types/index GET: ETag + 304', async () => {
  const r1 = await fetch(`${baseUrl}/types/index`);
  assert.equal(r1.status, 200);
  const etag = r1.headers.get('etag');
  assert.ok(etag);
  const r2 = await fetch(`${baseUrl}/types/index`, { headers: { 'If-None-Match': etag } });
  assert.equal(r2.status, 304);
});

test('/types/search GET: ETag present; POST unaffected', async () => {
  const r = await fetch(`${baseUrl}/types/search?type=${encodeURIComponent('https://www.w3.org/ns/lws#DataResource')}`);
  assert.equal(r.status, 200);
  assert.ok(r.headers.get('etag'));

  const post = await fetch(`${baseUrl}/types/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/lws+json' },
    body: JSON.stringify({ type: ['https://www.w3.org/ns/lws#DataResource'] }),
  });
  assert.equal(post.status, 200);
});
