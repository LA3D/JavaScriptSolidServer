// test/lws-profile-conneg-head-container.test.js
// Integration test: Task 8 — container GET Accept-Profile negotiation +
// HEAD/GET parity for Accept-Profile (files and containers).
//
// Mirrors test/lws-profile-conneg-get.test.js's harness (Task 7): a real
// client PUTs the resource's own .meta declaring the altr: default +
// alternate representations, then negotiates via Accept-Profile.
//
// Two things pinned here that Task 7 didn't cover:
//   1. The container GET path (resource.js, "no index.html" listing
//      branches: lws-json/linkset/turtle/jsonld) now runs the same
//      negotiateProfile gate as file GET — redirect/notacceptable/self.
//   2. HEAD returns the SAME status + Content-Profile/Link stamp as GET
//      for the same Accept-Profile, for both files and containers — the
//      whole point of HEAD (cheap discovery) requires this parity.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';

describe('Accept-Profile HEAD/GET parity — files', () => {
  const RES_PATH = '/alice/mem/mem-a.md';
  const ALT_PATH = '/alice/mem/mem-a.links.jsonld';
  const CONTENT_PROFILE = 'https://profiles.example/content';
  const LINKS_PROFILE = 'https://profiles.example/links';
  const UNKNOWN_PROFILE = 'https://profiles.example/nope';
  let RES, ALT;

  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('alice');
    const base = getBaseUrl();
    RES = `${base}${RES_PATH}`;
    ALT = `${base}${ALT_PATH}`;

    await request('/alice/mem/', { method: 'PUT', auth: 'alice' });
    await request(RES_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: '# hello',
      auth: 'alice',
    });
    await request(`${RES_PATH}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RES,
        'altr:hasDefaultRepresentation': {
          '@id': RES, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': CONTENT_PROFILE },
        },
        'altr:hasRepresentation': {
          '@id': ALT, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': LINKS_PROFILE },
        },
      }),
      auth: 'alice',
    });
  });

  after(async () => { await stopTestServer(); });

  it('HEAD with Accept-Profile matching a distinct alternate → 303 (same as GET)', async () => {
    const headers = { 'Accept-Profile': `<${LINKS_PROFILE}>` };
    const getRes = await request(RES_PATH, { headers, redirect: 'manual' });
    const headRes = await request(RES_PATH, { method: 'HEAD', headers, redirect: 'manual' });
    assertStatus(getRes, 303);
    assertStatus(headRes, 303);
    assert.equal(headRes.headers.get('location'), getRes.headers.get('location'));
    assert.equal(headRes.headers.get('content-profile'), getRes.headers.get('content-profile'));
    assert.match(headRes.headers.get('link') || '', /rel="profile"/);
  });

  it('HEAD with Accept-Profile matching the default → 200 + Content-Profile (same as GET)', async () => {
    const headers = { 'Accept-Profile': `<${CONTENT_PROFILE}>` };
    const getRes = await request(RES_PATH, { headers });
    const headRes = await request(RES_PATH, { method: 'HEAD', headers });
    assertStatus(getRes, 200);
    assertStatus(headRes, 200);
    assert.equal(headRes.headers.get('content-profile'), getRes.headers.get('content-profile'));
    assert.equal(headRes.headers.get('content-profile'), `<${CONTENT_PROFILE}>`);
    assert.match(headRes.headers.get('link') || '', /rel="profile"/);
  });

  it('HEAD with Accept-Profile matching nothing → 406 (same as GET)', async () => {
    const headers = { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` };
    const getRes = await request(RES_PATH, { headers });
    const headRes = await request(RES_PATH, { method: 'HEAD', headers });
    assertStatus(getRes, 406);
    assertStatus(headRes, 406);
  });

  // R12 (spec 2026-07-19): a bare HEAD (no Accept-Profile) of a resource
  // with a declared default rep now stamps too — same as GET (parity) —
  // since HEAD's served contentType matches the declared default's format.
  it('bare HEAD (no Accept-Profile) → R12 default-rep stamp, same as GET (parity)', async () => {
    const getRes = await request(RES_PATH);
    const headRes = await request(RES_PATH, { method: 'HEAD' });
    assertStatus(getRes, 200);
    assertStatus(headRes, 200);
    assert.equal(headRes.headers.get('content-profile'), `<${CONTENT_PROFILE}>`);
    assert.equal(headRes.headers.get('content-profile'), getRes.headers.get('content-profile'));
    assert.match(headRes.headers.get('link') || '', /rel="profile"/);
  });

  // 304-vs-profile-negotiation ordering: a cache-valid conditional request
  // must short-circuit to 304 BEFORE any profile redirect/406, on both GET
  // and HEAD. Regression pin for the HEAD ordering fix (negotiation block
  // moved to AFTER the If-None-Match check so it can't 303/406 a request
  // that GET would 304). Uses Accept-Profile: <alternate> — without the
  // 304 guard this would be a 303 redirect, so a 304 proves 304 wins.
  it('conditional GET (If-None-Match) + Accept-Profile → 304, not 303 (304 wins)', async () => {
    const probe = await request(RES_PATH, { method: 'HEAD' });
    const etag = probe.headers.get('etag');
    assert.ok(etag, 'prereq: ETag present');
    const res = await request(RES_PATH, {
      headers: { 'If-None-Match': etag, 'Accept-Profile': `<${LINKS_PROFILE}>` },
      redirect: 'manual',
    });
    assertStatus(res, 304);
  });

  it('conditional HEAD (If-None-Match) + Accept-Profile → 304 (parity with GET)', async () => {
    const probe = await request(RES_PATH, { method: 'HEAD' });
    const etag = probe.headers.get('etag');
    assert.ok(etag, 'prereq: ETag present');
    const res = await request(RES_PATH, {
      method: 'HEAD',
      headers: { 'If-None-Match': etag, 'Accept-Profile': `<${LINKS_PROFILE}>` },
      redirect: 'manual',
    });
    assertStatus(res, 304);
  });
});

describe('Accept-Profile container GET negotiation (no index.html)', () => {
  const CONTAINER_PATH = '/bob/mem/';
  const ALT_PATH = '/bob/mem-alt.jsonld';
  const DEFAULT_PROFILE = 'https://profiles.example/container-default';
  const ALT_PROFILE = 'https://profiles.example/container-alt';
  const UNKNOWN_PROFILE = 'https://profiles.example/container-nope';
  let CONTAINER, ALT;

  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('bob');
    const base = getBaseUrl();
    CONTAINER = `${base}${CONTAINER_PATH}`;
    ALT = `${base}${ALT_PATH}`;

    await request(CONTAINER_PATH, { method: 'PUT', auth: 'bob' });
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
      auth: 'bob',
    });
  });

  after(async () => { await stopTestServer(); });

  it('GET container Accept-Profile matching the default → self (200, stamped)', async () => {
    const res = await request(CONTAINER_PATH, { headers: { 'Accept-Profile': `<${DEFAULT_PROFILE}>` } });
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), `<${DEFAULT_PROFILE}>`);
    assert.match(res.headers.get('link') || '', /rel="profile"/);
  });

  it('GET container Accept-Profile matching a distinct alternate → redirect (303 + Location)', async () => {
    const res = await request(CONTAINER_PATH, {
      headers: { 'Accept-Profile': `<${ALT_PROFILE}>` },
      redirect: 'manual',
    });
    assertStatus(res, 303);
    assert.equal(res.headers.get('location'), ALT);
    assert.equal(res.headers.get('content-profile'), `<${ALT_PROFILE}>`);
  });

  it('GET container Accept-Profile matching nothing → 406', async () => {
    const res = await request(CONTAINER_PATH, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` } });
    assertStatus(res, 406);
  });

  // R12: this container's .meta declares a default representation whose
  // format ('application/ld+json') matches the bare-GET served body — the
  // media-equality guard passes, so the stamp now applies here too.
  it('bare GET container (no Accept-Profile) → R12 default-rep stamp applies (media match)', async () => {
    const res = await request(CONTAINER_PATH);
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), `<${DEFAULT_PROFILE}>`);
  });

  it('HEAD container Accept-Profile parity: redirect/self/406 match GET', async () => {
    for (const [profile, expected] of [
      [DEFAULT_PROFILE, 200],
      [ALT_PROFILE, 303],
      [UNKNOWN_PROFILE, 406],
    ]) {
      const headers = { 'Accept-Profile': `<${profile}>` };
      const getRes = await request(CONTAINER_PATH, { headers, redirect: 'manual' });
      const headRes = await request(CONTAINER_PATH, { method: 'HEAD', headers, redirect: 'manual' });
      assertStatus(getRes, expected, `GET ${profile}`);
      assertStatus(headRes, expected, `HEAD ${profile}`);
      assert.equal(headRes.headers.get('content-profile'), getRes.headers.get('content-profile'),
        `Content-Profile parity for ${profile}`);
    }
  });
});

describe('Accept-Profile container GET — index.html shadowed (out of scope, regression)', () => {
  const CONTAINER_PATH = '/carol/site/';
  const DEFAULT_PROFILE = 'https://profiles.example/site-default';
  let CONTAINER;

  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('carol');
    const base = getBaseUrl();
    CONTAINER = `${base}${CONTAINER_PATH}`;

    await request(CONTAINER_PATH, { method: 'PUT', auth: 'carol' });
    await request(`${CONTAINER_PATH}index.html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: '<html><body>hi</body></html>',
      auth: 'carol',
    });
    // Declares an altr: default even though index.html shadows every Accept —
    // profile negotiation must NOT engage here (design decision: index.html
    // and the mashlib wrapper are out of scope for the altr: family).
    await request(`${CONTAINER_PATH}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': CONTAINER,
        'altr:hasDefaultRepresentation': {
          '@id': CONTAINER, 'dct:format': 'text/html', 'dct:conformsTo': { '@id': DEFAULT_PROFILE },
        },
      }),
      auth: 'carol',
    });
  });

  after(async () => { await stopTestServer(); });

  it('GET with Accept-Profile on an index.html-shadowed container → 200 html, no negotiation', async () => {
    const res = await request(CONTAINER_PATH, { headers: { 'Accept-Profile': `<${DEFAULT_PROFILE}>` } });
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), null);
    assert.equal(await res.text(), '<html><body>hi</body></html>');
  });

  it('HEAD matches GET for the same shadowed case', async () => {
    const headers = { 'Accept-Profile': `<${DEFAULT_PROFILE}>` };
    const getRes = await request(CONTAINER_PATH, { headers });
    const headRes = await request(CONTAINER_PATH, { method: 'HEAD', headers });
    assertStatus(getRes, 200);
    assertStatus(headRes, 200);
    assert.equal(headRes.headers.get('content-profile'), getRes.headers.get('content-profile'));
  });
});

// R12 negative: the wiki family gives containers no default rep, so a
// container with none must stay stamp-free even when a bare GET is served —
// defaultProfileFor requires representations.default to exist at all.
describe('R12: container with only alternates (no default rep) stays stamp-free', () => {
  const CONTAINER_PATH = '/gina/mem/';
  const ALT_PATH = '/gina/mem-alt.jsonld';
  const ALT_PROFILE = 'https://profiles.example/gina-alt';
  let CONTAINER, ALT;

  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('gina');
    const base = getBaseUrl();
    CONTAINER = `${base}${CONTAINER_PATH}`;
    ALT = `${base}${ALT_PATH}`;

    await request(CONTAINER_PATH, { method: 'PUT', auth: 'gina' });
    await request(`${CONTAINER_PATH}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': CONTAINER,
        'altr:hasRepresentation': {
          '@id': ALT, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': ALT_PROFILE },
        },
      }),
      auth: 'gina',
    });
  });

  after(async () => { await stopTestServer(); });

  it('bare GET → no Content-Profile (no default rep declared)', async () => {
    const res = await request(CONTAINER_PATH);
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), null);
  });

  it('bare HEAD → no Content-Profile, matches GET', async () => {
    const getRes = await request(CONTAINER_PATH);
    const headRes = await request(CONTAINER_PATH, { method: 'HEAD' });
    assertStatus(headRes, 200);
    assert.equal(headRes.headers.get('content-profile'), null);
    assert.equal(headRes.headers.get('content-profile'), getRes.headers.get('content-profile'));
  });
});

// Fix (review finding, spec 2026-07-19) HEAD parity: the entity-face
// wrapper's HEAD twin (resource.js isEntityFaceResponse branch) must
// suppress the profile stamp exactly like GET does — see the GET-side
// fixture/rationale in test/lws-profile-conneg-get.test.js.
describe('synthetic-view stamp suppression: entity-face wrapper (?view=nav) HEAD parity', () => {
  const RES_PATH5 = '/henry/wiki/page.html';
  const PROFILE_H = 'https://profiles.example/henry-wiki';
  const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const PAGE_BODY = '<html><body>henry page</body></html>';
  let RES5;

  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('henry');
    const base = getBaseUrl();
    RES5 = `${base}${RES_PATH5}`;

    await request('/henry/wiki/', { method: 'PUT', auth: 'henry' });
    await request(RES_PATH5, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: PAGE_BODY,
      auth: 'henry',
    });
    await request(`${RES_PATH5}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RES5,
        'altr:hasDefaultRepresentation': {
          '@id': RES5, 'dct:format': 'text/html', 'dct:conformsTo': { '@id': PROFILE_H },
        },
      }),
      auth: 'henry',
    });
  });

  after(async () => { await stopTestServer(); });

  it('HEAD direct (own bytes, no ?view=nav) -> Content-Profile present, parity with GET (unchanged)', async () => {
    const getRes = await request(RES_PATH5);
    const headRes = await request(RES_PATH5, { method: 'HEAD' });
    assertStatus(getRes, 200);
    assertStatus(headRes, 200);
    assert.equal(headRes.headers.get('content-profile'), `<${PROFILE_H}>`);
    assert.equal(headRes.headers.get('content-profile'), getRes.headers.get('content-profile'));
  });

  it('HEAD ?view=nav (synthetic entity-face wrapper) -> 200, NO Content-Profile, parity with GET', async () => {
    const getRes = await request(`${RES_PATH5}?view=nav`, { headers: { Accept: BROWSER_ACCEPT } });
    const headRes = await request(`${RES_PATH5}?view=nav`, { method: 'HEAD', headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(getRes, 200);
    assertStatus(headRes, 200);
    assert.equal(headRes.headers.get('content-profile'), null);
    assert.equal(headRes.headers.get('content-profile'), getRes.headers.get('content-profile'));
    assert.doesNotMatch(headRes.headers.get('link') || '', /rel="profile"/);
    const link = headRes.headers.get('link') || '';
    assert.ok(link.includes('rel="canonical"'), `canonical entry must still be advertised, got: ${link}`);
  });
});
