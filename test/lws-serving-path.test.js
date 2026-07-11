// test/lws-serving-path.test.js
// The --lws serving arm end-to-end (spec 2026-07-10 §2): a real parser feeds
// Turtle/N-Triples/N-Quads conneg; lossy/failed conversions 406-teach.
// Resources live under /alice/public/ (pod-creation public-read default ACL).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

const DOC = '/alice/public/servepath-graphdoc.jsonld';
const NG = '/alice/public/servepath-namedgraph.jsonld';
const REMOTE = '/alice/public/servepath-remotectx.jsonld';

describe('LWS serving path (dataset seam + 406 teaching)', () => {
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    await createTestPod('alice');
    const base = getBaseUrl();
    await request(DOC, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@context': { name: 'https://schema.org/name' }, '@graph': [
        { '@id': `${base}${DOC}#a`, name: 'A' }, { '@id': `${base}${DOC}#b`, name: 'B' }] }) });
    await request(NG, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@context': { name: 'https://schema.org/name' }, '@id': `${base}${NG}#g`, '@graph': [
        { '@id': `${base}${NG}#a`, name: 'A' }] }) });
    await request(REMOTE, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@context': 'https://schema.org', '@id': `${base}${REMOTE}#a`, name: 'A' }) });
  });
  after(async () => { await stopTestServer(); });

  it('GET @graph doc as Turtle → 200 real triples (probe-#4 signature dead)', async () => {
    const res = await request(DOC, { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 200);
    assert.match(res.headers.get('content-type'), /text\/turtle/);
    const body = await res.text();
    assert.match(body, /"A"/);
    assert.match(body, /"B"/);
  });

  it('named-graph doc: Turtle 406 problem+json teaching; N-Quads 200 lossless', async () => {
    const ttl = await request(NG, { headers: { Accept: 'text/turtle' } });
    assertStatus(ttl, 406);
    assert.match(ttl.headers.get('content-type'), /application\/problem\+json/);
    const problem = await ttl.json();
    assert.match(problem.detail, /named graphs/);
    assert.match(problem.detail, /application\/n-quads/);
    const nq = await request(NG, { headers: { Accept: 'application/n-quads' } });
    assertStatus(nq, 200);
    assert.match(nq.headers.get('content-type'), /application\/n-quads/);
    const nqBody = await nq.text();
    assert.match(nqBody, /#g>/);
  });

  it('remote-@context doc as Turtle → 406 teaching, never a mislabeled 200', async () => {
    const res = await request(REMOTE, { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 406);
    const problem = await res.json();
    assert.match(problem.detail, /remote @context/);
  });

  it('HEAD parity: 406 on the named-graph doc, converted content-type on the good doc', async () => {
    const h406 = await request(NG, { method: 'HEAD', headers: { Accept: 'text/turtle' } });
    assertStatus(h406, 406);
    const h200 = await request(DOC, { method: 'HEAD', headers: { Accept: 'text/turtle' } });
    assertStatus(h200, 200);
    assert.match(h200.headers.get('content-type'), /text\/turtle/);
  });

  it('JSON-LD Accept unchanged: stored @graph doc round-trips', async () => {
    const res = await request(DOC, { headers: { Accept: 'application/ld+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.ok(body['@graph']);
  });

  it('container listing as Turtle carries member IRIs (via the dataset arm)', async () => {
    const res = await request('/alice/public/', { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 200);
    assert.match(res.headers.get('content-type'), /text\/turtle/);
    const body = await res.text();
    assert.match(body, /servepath-graphdoc\.jsonld/);
    assert.match(body, /ldp#contains|ldp:contains/);
  });

  it('container listing negotiates application/n-quads under --lws', async () => {
    const res = await request('/alice/public/', { headers: { Accept: 'application/n-quads' } });
    assertStatus(res, 200);
    assert.match(res.headers.get('content-type'), /application\/n-quads/);
    const body = await res.text();
    assert.match(body, /servepath-graphdoc\.jsonld/);
  });
});
