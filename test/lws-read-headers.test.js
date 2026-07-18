// R1/R2 (matrix 2026-07-18): every --lws GET/HEAD response Link header carries
// rel="up" (non-root) + rel="type" -> lws#DataResource|Container, derived by the
// SAME helpers as the linkset body (header parity). --lws off: byte-identical.
import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getAllHeaders } from '../src/ldp/headers.js';
import { startTestServer, stopTestServer, getBaseUrl, createTestPod } from './helpers.js';

const LWS = 'https://www.w3.org/ns/lws#';

test('getAllHeaders --lws: data resource gets up + lws type links', () => {
  const h = getAllHeaders({ isContainer: false, lwsEnabled: true, resourceUrl: 'http://x/alice/notes/a.md' });
  assert.match(h.Link, /<http:\/\/x\/alice\/notes\/>; rel="up"/);
  assert.match(h.Link, new RegExp(`<${LWS}DataResource>; rel="type"`));
  assert.match(h.Link, /<http:\/\/www\.w3\.org\/ns\/ldp#Resource>; rel="type"/); // LDP types preserved
});

test('getAllHeaders --lws: container gets up + lws Container type', () => {
  const h = getAllHeaders({ isContainer: true, lwsEnabled: true, resourceUrl: 'http://x/alice/notes/' });
  assert.match(h.Link, /<http:\/\/x\/alice\/>; rel="up"/);
  assert.match(h.Link, new RegExp(`<${LWS}Container>; rel="type"`));
});

test('getAllHeaders --lws: origin root has no up link', () => {
  const h = getAllHeaders({ isContainer: true, lwsEnabled: true, resourceUrl: 'http://x/' });
  assert.doesNotMatch(h.Link, /rel="up"/);
});

test('getAllHeaders without --lws: no up, no lws type (byte-identical control)', () => {
  const h = getAllHeaders({ isContainer: false, lwsEnabled: false, resourceUrl: 'http://x/alice/a.md' });
  assert.doesNotMatch(h.Link, /rel="up"/);
  assert.doesNotMatch(h.Link, new RegExp(LWS.replace(/[/#]/g, '\\$&')));
});

// GET vs HEAD Link parity on the wire (handleHead mirrors by duplication — lock it).
describe('lws: wire-level up/type Link parity', () => {
  let base, token;
  before(async () => {
    await startTestServer({ lws: true });
    base = getBaseUrl();
    const pod = await createTestPod('headlinks');
    token = pod.token;
    const put = await fetch(`${base}/headlinks/hello.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` },
      body: 'hello',
    });
    assert.equal(put.status, 201);
  });
  after(async () => { await stopTestServer(); });

  it('GET and HEAD emit identical Link header incl. up/type', async () => {
    const url = `${base}/headlinks/hello.txt`;
    const g = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const h = await fetch(url, { method: 'HEAD', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(h.headers.get('link'), g.headers.get('link'));
    assert.match(g.headers.get('link'), /rel="up"/);
    assert.match(g.headers.get('link'), new RegExp(`<${LWS}DataResource>; rel="type"`));
  });
});
