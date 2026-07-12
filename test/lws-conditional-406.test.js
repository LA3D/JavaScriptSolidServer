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

  // HEAD twin of the test above — the same Accept that would be
  // unsatisfiable-under-lws (turtle vs a markdown resource) is a no-op off
  // --lws, so wouldNotNegotiate's conjuncts (request.lwsEnabled) collapse it
  // to false and HEAD takes the same bare fast path as GET, byte-identical.
  it('HEAD: a mismatched Accept still 304s off the bare fast path (no F3/profile gates exist without --lws)', async () => {
    const r = await request('/c46neg/card.md', { method: 'HEAD', headers: { 'If-None-Match': etag, Accept: 'text/turtle' }, auth: 'c46neg' });
    assert.equal(r.status, 304);
  });
});

describe('lws: 304-wins-over-303 and 406-never-304 — containers', () => {
  // Mirrors the file-arm fixture in
  // test/lws-profile-conneg-head-container.test.js — a container with its
  // own .meta declaring an altr: default + a distinct alternate
  // representation, negotiated via Accept-Profile. Pins that the container
  // listing branch (resource.js ~557-603) has the same 304-vs-406/303
  // ordering as the file branch (~767-819) that describe('lws: 304 never
  // beats 406') above already covers — container coverage was trace-only
  // per the debt-drain review.
  const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
  const DCT = 'http://purl.org/dc/terms/';
  const CONTAINER_PATH = '/c46cont/mem/';
  const ALT_PATH = '/c46cont/mem-alt.jsonld';
  const DEFAULT_PROFILE = 'https://profiles.example/c46-container-default';
  const ALT_PROFILE = 'https://profiles.example/c46-container-alt';
  const UNKNOWN_PROFILE = 'https://profiles.example/c46-container-nope';
  let CONTAINER, ALT, listingEtag;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    await createTestPod('c46cont');
    const base = getBaseUrl();
    CONTAINER = `${base}${CONTAINER_PATH}`;
    ALT = `${base}${ALT_PATH}`;

    await request(CONTAINER_PATH, { method: 'PUT', auth: 'c46cont' });
    await request(`${CONTAINER_PATH}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': CONTAINER,
        'altr:hasDefaultRepresentation': {
          '@id': CONTAINER, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': DEFAULT_PROFILE },
        },
        'altr:hasRepresentation': {
          '@id': ALT, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': ALT_PROFILE },
        },
      }),
      auth: 'c46cont',
    });

    const probe = await request(CONTAINER_PATH, { auth: 'c46cont' });
    listingEtag = probe.headers.get('etag');
  });
  after(stopTestServer);

  it('container: If-None-Match + Accept-Profile matching an alternate (would-303) → 304, not 303 (304 wins)', async () => {
    const r = await request(CONTAINER_PATH, {
      headers: { 'If-None-Match': listingEtag, 'Accept-Profile': `<${ALT_PROFILE}>` },
      auth: 'c46cont',
      redirect: 'manual',
    });
    assert.equal(r.status, 304);
  });

  it('container: If-None-Match + Accept-Profile matching nothing (would-406) → 406, never 304', async () => {
    const r = await request(CONTAINER_PATH, {
      headers: { 'If-None-Match': listingEtag, 'Accept-Profile': `<${UNKNOWN_PROFILE}>` },
      auth: 'c46cont',
    });
    assert.equal(r.status, 406);
  });
});
