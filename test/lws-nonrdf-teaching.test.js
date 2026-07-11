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

  // RFC 9110 §12.5.1: q=0 is explicitly NOT acceptable, even for a type that
  // would otherwise match — acceptSatisfiable must not treat it as satisfying.
  it('markdown + Accept: text/markdown;q=0 → 406 (q=0 excludes the otherwise-matching type)', async () => {
    const r = await request(`${base}/f3/card.md`, { headers: { Accept: 'text/markdown;q=0' }, auth: 'f3' });
    assert.equal(r.status, 406);
  });

  it('markdown + Accept: text/markdown;q=0, */* → 200 (the wildcard still satisfies)', async () => {
    const r = await request(`${base}/f3/card.md`, { headers: { Accept: 'text/markdown;q=0, */*' }, auth: 'f3' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'text/markdown');
  });
});

// F3 GET/HEAD parity + declared-representations 406 branch (spec 2026-07-11
// §3): a resource WITH a .meta (altr: default + one alternate) that can't
// satisfy the Accept must 406 with a Link header listing what IS available
// (rel="canonical"/"alternate") — GET and HEAD must carry the identical
// Link (RFC 9110 §9.3.2), and the problem detail must point at it.
describe('lws: teaching 406 with declared representations (.meta present)', () => {
  const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
  const DCT = 'http://purl.org/dc/terms/';
  const PROFILE_DEFAULT = 'https://profiles.example/f3rep-content';
  const PROFILE_ALT = 'https://profiles.example/f3rep-links';
  let base, RES, ALT;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    await createTestPod('f3rep');
    RES = `${base}/f3rep/card.md`;
    ALT = `${base}/f3rep/card.links.jsonld`;
    await request(RES, { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'f3rep',
      body: '# A card\n' });
    await request(`${RES}.meta`, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'f3rep',
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RES,
        'altr:hasDefaultRepresentation': { '@id': RES, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': PROFILE_DEFAULT } },
        'altr:hasRepresentation': { '@id': ALT, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': PROFILE_ALT } },
      }),
    });
  });
  after(stopTestServer);

  it('GET markdown + unsatisfiable Accept: text/turtle → 406 with Link rel="alternate" and detail naming the Link header', async () => {
    const r = await request(RES, { headers: { Accept: 'text/turtle' }, auth: 'f3rep' });
    assert.equal(r.status, 406);
    const link = r.headers.get('link') || '';
    assert.match(link, /rel="alternate"/);
    const p = await r.json();
    assert.match(p.detail, /Link header/);
  });

  it('HEAD carries the SAME Link header as GET on the 406 (RFC 9110 §9.3.2 parity), empty body', async () => {
    const getRes = await request(RES, { headers: { Accept: 'text/turtle' }, auth: 'f3rep' });
    const headRes = await request(RES, { method: 'HEAD', headers: { Accept: 'text/turtle' }, auth: 'f3rep' });
    assert.equal(headRes.status, 406);
    assert.equal(headRes.headers.get('link'), getRes.headers.get('link'));
    assert.match(headRes.headers.get('link') || '', /rel="alternate"/);
  });
});
