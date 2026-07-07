// test/lws-profile-conneg-get.test.js
// Integration test: Task 7 — negotiateProfile wired into the file GET path.
// Mirrors lws-discovery-conformance.test.js's harness (startTestServer +
// public:true to bypass WAC so a bare `request()` works) and
// lws-admission-put.test.js's pattern of PUTting a resource's own .meta
// directly — the altr: representation declarations are client-managed
// (src/lws/representations.js), so a real client PUTs them the same way.
// Keeps the unit test (test/conneg-negotiate.test.js) authoritative for the
// negotiateProfile outcome matrix; this file only proves the file-GET wiring
// (redirect/notacceptable short-circuit, self fall-through + stamping via
// getAllHeaders' chosenProfile param — fix round 1). The whole block is now
// additionally gated on the Accept-Profile request header: a bare GET does
// zero .meta I/O and gets no stamp (see the "bare GET unchanged" case below).
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
    const link = res.headers.get('link') || '';
    assert.match(link, /rel="profile"/);
    // Centralizing the stamp in getAllHeaders (fix round 1) must not
    // clobber the Link header's other pre-existing relations — proves
    // the comma-join, not an overwrite.
    assert.match(link, /rel="type"/);
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

  it('no Accept-Profile → conneg block skipped entirely, bare GET unchanged (200, no stamp)', async () => {
    const res = await request(RES_PATH);
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), null);
    assert.doesNotMatch(res.headers.get('link') || '', /rel="profile"/);
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

// Fix round 1 (getAllHeaders chosenProfile centralization): prove the stamp
// reaches a serve branch OTHER than the final serve-as-is block. conneg
// must be ON so the plain-JSON-LD→Turtle conneg branch (resource.js ~703)
// runs instead of the as-is path; that branch returns before reaching the
// serve-as-is code, so it only gets the stamp if getAllHeaders applies it.
describe('Accept-Profile stamp on a non-serve-as-is branch (conneg enabled)', () => {
  const RDF_PATH = '/carol/data/item.jsonld';
  const RDF_PROFILE = 'https://profiles.example/rdf-content';
  let RES;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, public: true });
    await createTestPod('carol');
    const base = getBaseUrl();
    RES = `${base}${RDF_PATH}`;

    await request('/carol/data/', { method: 'PUT', auth: 'carol' });
    await request(RDF_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { dct: DCT },
        '@id': RES,
        'dct:title': 'hello',
      }),
      auth: 'carol',
    });
    await request(`${RDF_PATH}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RES,
        'altr:hasDefaultRepresentation': {
          '@id': RES, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': RDF_PROFILE },
        },
      }),
      auth: 'carol',
    });
  });

  after(async () => { await stopTestServer(); });

  it('Accept-Profile: <default> + Accept: text/turtle → self, 200, stamped on the conneg-conversion branch', async () => {
    const res = await request(RDF_PATH, {
      headers: { 'Accept-Profile': `<${RDF_PROFILE}>`, 'Accept': 'text/turtle' },
    });
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-type'), 'text/turtle');
    assert.equal(res.headers.get('content-profile'), `<${RDF_PROFILE}>`);
    assert.match(res.headers.get('link') || '', /rel="profile"/);
  });
});

// Fix round 2, fix 1: the per-resource linkset branch (resource.js ~614-638,
// application/linkset+json) built its own getAllHeaders({...}) call but
// never passed chosenProfile, so a client asking for the linkset AND
// negotiating a matching profile got the linkset body with no
// Content-Profile/Link rel="profile" stamp. Proves that branch now stamps
// like the other five file-GET serve branches.
describe('Accept-Profile stamp on the linkset serve branch (Accept: application/linkset+json)', () => {
  const RES_PATH2 = '/dana/mem/mem-b.md';
  const DANA_PROFILE = 'https://profiles.example/dana-content';
  let RES2;

  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('dana');
    const base = getBaseUrl();
    RES2 = `${base}${RES_PATH2}`;

    await request('/dana/mem/', { method: 'PUT', auth: 'dana' });
    await request(RES_PATH2, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: '# hi dana',
      auth: 'dana',
    });
    await request(`${RES_PATH2}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RES2,
        'altr:hasDefaultRepresentation': {
          '@id': RES2, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': DANA_PROFILE },
        },
      }),
      auth: 'dana',
    });
  });

  after(async () => { await stopTestServer(); });

  it('Accept-Profile: <default> + Accept: application/linkset+json → 200, linkset body, stamped', async () => {
    const res = await request(RES_PATH2, {
      headers: { 'Accept-Profile': `<${DANA_PROFILE}>`, 'Accept': 'application/linkset+json' },
    });
    assertStatus(res, 200);
    assert.match(res.headers.get('content-type') || '', /^application\/linkset\+json/);
    assert.equal(res.headers.get('content-profile'), `<${DANA_PROFILE}>`);
    assert.match(res.headers.get('link') || '', /rel="profile"/);
    const body = await res.json();
    assert.ok(Array.isArray(body.linkset));
  });
});

// Fix round 2, fix 2: chosenProfile was being set unconditionally to
// neg.rep.profile on the assumption 'none' can't occur once Accept-Profile
// is present. But parseAcceptProfile can return [] for a non-empty-but-
// content-less header (e.g. "Accept-Profile: ,"), so negotiateProfile
// returns { outcome: 'none', rep: null } and neg.rep.profile threw a
// TypeError → 500. Proves the guarded form degrades gracefully instead.
describe('Accept-Profile malformed-but-present header (regression, no crash)', () => {
  const RES_PATH3 = '/erin/notes/note.md';
  let RES3;

  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('erin');
    const base = getBaseUrl();
    RES3 = `${base}${RES_PATH3}`;

    await request('/erin/notes/', { method: 'PUT', auth: 'erin' });
    await request(RES_PATH3, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: '# erin',
      auth: 'erin',
    });
  });

  after(async () => { await stopTestServer(); });

  it('Accept-Profile: "," (present but parses to empty) → 200, served normally, no stamp', async () => {
    const res = await request(RES_PATH3, { headers: { 'Accept-Profile': ',' } });
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), null);
    assert.doesNotMatch(res.headers.get('link') || '', /rel="profile"/);
    assert.equal(await res.text(), '# erin');
  });
});
