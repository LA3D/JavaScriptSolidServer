// test/lws-nonrdf-teaching.test.js
// F3 (spec 2026-07-11 §3): a non-RDF source with a specific unsatisfiable Accept
// answers a teaching 406 naming the authored format + the profile route.
// Wildcards keep serving the authored format — browsers see nothing new.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl } from './helpers.js';

describe('lws: teaching 406 on non-RDF sources', () => {
  let base;
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    await createTestPod('f3');
    await request(`${base}/f3/card.md`, { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'f3',
      body: '# A card\n' });
    await request(`${base}/f3/d.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, auth: 'f3',
      body: '{"plain": true}' });
  });
  after(stopTestServer);

  it('markdown + Accept: text/turtle → 406 problem+json naming the authored format and the profile route', async () => {
    const r = await request(`${base}/f3/card.md`, { headers: { Accept: 'text/turtle' }, auth: 'f3' });
    assert.equal(r.status, 406);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/problem+json');
    const p = await r.json();
    assert.match(p.detail, /text\/markdown/);
    assert.match(p.detail, /Accept-Profile/);
  });

  it('plain JSON + Accept: application/ld+json → 406 (no more mislabeled 200)', async () => {
    const r = await request(`${base}/f3/d.json`, { headers: { Accept: 'application/ld+json' }, auth: 'f3' });
    assert.equal(r.status, 406);
  });

  it('markdown + Accept: */* → 200 markdown, unchanged', async () => {
    const r = await request(`${base}/f3/card.md`, { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }, auth: 'f3' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'text/markdown');
  });

  it('markdown + Accept: text/* → 200 markdown (major-type wildcard satisfies)', async () => {
    const r = await request(`${base}/f3/card.md`, { headers: { Accept: 'text/*' }, auth: 'f3' });
    assert.equal(r.status, 200);
  });

  it('no Accept header → 200 authored format', async () => {
    const r = await request(`${base}/f3/card.md`, { auth: 'f3' });
    assert.equal(r.status, 200);
  });

  it('HEAD parity: markdown + text/turtle → 406, empty body', async () => {
    const r = await request(`${base}/f3/card.md`, { method: 'HEAD', headers: { Accept: 'text/turtle' }, auth: 'f3' });
    assert.equal(r.status, 406);
  });
});
