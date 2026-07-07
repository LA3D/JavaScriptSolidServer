// test/lws-profile-conneg-get.test.js
// Integration test: Task 7 — negotiateProfile wired into the file GET path.
// Mirrors lws-discovery-conformance.test.js's harness (startTestServer +
// public:true to bypass WAC so a bare `request()` works) and
// lws-admission-put.test.js's pattern of PUTting a resource's own .meta
// directly — the altr: representation declarations are client-managed
// (src/lws/representations.js), so a real client PUTs them the same way.
// Keeps the unit test (test/conneg-negotiate.test.js) authoritative for the
// negotiateProfile outcome matrix; this file only proves the file-GET wiring
// (redirect/notacceptable short-circuit, self/none fall-through + stamping).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';
const RES_PATH = '/alice/mem/mem-a.md';
const ALT_PATH = '/alice/mem/mem-a.links.jsonld';
const CONTENT_PROFILE = 'https://profiles.example/content';
const LINKS_PROFILE = 'https://profiles.example/links';
const UNKNOWN_PROFILE = 'https://profiles.example/nope';

describe('Accept-Profile file GET (--lws, lwsProfileConneg ON by default)', () => {
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
    // Client-managed .meta declaring the altr: default + one alternate.
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

  it('Accept-Profile matching the default representation → self (200, stamped)', async () => {
    const res = await request(RES_PATH, { headers: { 'Accept-Profile': `<${CONTENT_PROFILE}>` } });
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), `<${CONTENT_PROFILE}>`);
    assert.match(res.headers.get('link') || '', /rel="profile"/);
    assert.equal(await res.text(), '# hello');
  });

  it('Accept-Profile matching a distinct alternate → redirect (303 + Location + Content-Profile)', async () => {
    const res = await request(RES_PATH, {
      headers: { 'Accept-Profile': `<${LINKS_PROFILE}>` },
      redirect: 'manual',
    });
    assertStatus(res, 303);
    assert.equal(res.headers.get('location'), ALT);
    assert.equal(res.headers.get('content-profile'), `<${LINKS_PROFILE}>`);
    assert.match(res.headers.get('link') || '', /rel="profile"/);
  });

  it('Accept-Profile with no matching representation → 406', async () => {
    const res = await request(RES_PATH, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` } });
    assertStatus(res, 406);
  });

  it('no Accept-Profile → outcome none, still stamps the declared default profile (200, body unchanged)', async () => {
    const res = await request(RES_PATH);
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), `<${CONTENT_PROFILE}>`);
    assert.equal(await res.text(), '# hello');
  });
});

describe('Accept-Profile file GET regression (no .meta representations declared)', () => {
  const PLAIN_PATH = '/bob/notes/plain.md';

  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('bob');
    await request('/bob/notes/', { method: 'PUT', auth: 'bob' });
    await request(PLAIN_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: '# plain',
      auth: 'bob',
    });
  });

  after(async () => { await stopTestServer(); });

  it('GET with no .meta and no Accept-Profile → unaffected (200, no Content-Profile)', async () => {
    const res = await request(PLAIN_PATH);
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), null);
    assert.equal(await res.text(), '# plain');
  });

  it('GET with Accept-Profile but no declared representations → 406', async () => {
    const res = await request(PLAIN_PATH, { headers: { 'Accept-Profile': `<${CONTENT_PROFILE}>` } });
    assertStatus(res, 406);
  });
});
