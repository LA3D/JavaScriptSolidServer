// test/lws-conditional-406.test.js
// Spec §3 (RFC 9110 §13.2.2): preconditions apply only to requests that would
// otherwise succeed. A conditional request that would 406 (unsatisfiable
// Accept, media F3 arm or the profile arm) must answer the 406, never a
// short-circuit 304 — the early If-None-Match check used to run before
// either 406 gate.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl } from './helpers.js';

describe('lws: 304 never beats 406', () => {
  let etag;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    await createTestPod('c46');
    await request('/c46/card.md', { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'c46', body: '# c\n' });
    const r = await request('/c46/card.md', { auth: 'c46' });
    etag = r.headers.get('etag');
  });
  after(stopTestServer);

  it('If-None-Match + unsatisfiable Accept → 406, not 304', async () => {
    const r = await request('/c46/card.md', { headers: { 'If-None-Match': etag, Accept: 'text/turtle' }, auth: 'c46' });
    assert.equal(r.status, 406);
  });

  it('If-None-Match + satisfiable Accept → 304 (unchanged fast path)', async () => {
    const r = await request('/c46/card.md', { headers: { 'If-None-Match': etag, Accept: 'text/markdown' }, auth: 'c46' });
    assert.equal(r.status, 304);
  });

  it('HEAD parity: conditional + unsatisfiable Accept → 406', async () => {
    const r = await request('/c46/card.md', { method: 'HEAD', headers: { 'If-None-Match': etag, Accept: 'text/turtle' }, auth: 'c46' });
    assert.equal(r.status, 406);
  });

  it('the 304 response Vary names Accept-Profile', async () => {
    const r = await request('/c46/card.md', { headers: { 'If-None-Match': etag, Accept: 'text/markdown' }, auth: 'c46' });
    assert.equal(r.status, 304);
    assert.match(r.headers.get('vary') || '', /Accept-Profile/);
  });
});

describe('negative control: --lws off, conditional fast path unchanged', () => {
  let etag;

  before(async () => {
    await startTestServer({ lws: false, conneg: true });
    await createTestPod('c46neg');
    await request('/c46neg/card.md', { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'c46neg', body: '# c\n' });
    const r = await request('/c46neg/card.md', { auth: 'c46neg' });
    etag = r.headers.get('etag');
  });
  after(stopTestServer);

  it('a mismatched Accept still 304s off the bare fast path (no F3/profile gates exist without --lws)', async () => {
    const r = await request('/c46neg/card.md', { headers: { 'If-None-Match': etag, Accept: 'text/turtle' }, auth: 'c46neg' });
    assert.equal(r.status, 304);
  });
});
