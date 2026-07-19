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
    // Final-review fix 1: the 303 short-circuit must carry the FULL Vary
    // (same as the 200 serve path), not just 'Accept-Profile' — dropping
    // Authorization here made a cache keyed on URL+Accept-Profile blind to
    // the fact this outcome is authz-dependent (no-oracle cache-correctness).
    const vary = res.headers.get('vary') || '';
    assert.match(vary, /Authorization/, `303 Vary must include Authorization, got: ${vary}`);
    assert.match(vary, /Accept-Profile/, `303 Vary must include Accept-Profile, got: ${vary}`);
  });

  it('Accept-Profile with no matching representation → 406', async () => {
    const res = await request(RES_PATH, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` } });
    assertStatus(res, 406);
    // Final-review fix 1: same full-Vary requirement on the 406 short-circuit.
    const vary = res.headers.get('vary') || '';
    assert.match(vary, /Authorization/, `406 Vary must include Authorization, got: ${vary}`);
    assert.match(vary, /Accept-Profile/, `406 Vary must include Accept-Profile, got: ${vary}`);
  });

  it('no Accept-Profile → conneg block skipped, but R12 default-rep stamp still applies (200, stamped)', async () => {
    const res = await request(RES_PATH);
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-profile'), `<${CONTENT_PROFILE}>`);
    assert.match(res.headers.get('link') || '', /rel="profile"/);
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

describe('representation-list advertisement (DX-PROF-CONNEG §8.2.1 list-profiles)', () => {
  // Emitted whenever the negotiation block runs (Accept-Profile present — the
  // DX Example-19 "send Accept-Profile just in case" discovery pattern), AND
  // (A1, gateway spec §4) on the bare 200 whenever a .meta declares reps —
  // .meta-less resources stay at one storage.exists() (test/lws-bare-alternates.test.js).
  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('alice');
    const base = getBaseUrl();
    RES = `${base}${RES_PATH}`;
    ALT = `${base}${ALT_PATH}`;
    await request('/alice/mem/', { method: 'PUT', auth: 'alice' });
    await request(RES_PATH, { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, body: '# hello', auth: 'alice' });
    await request(`${RES_PATH}.meta`, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RES,
        'altr:hasDefaultRepresentation': { '@id': RES, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': CONTENT_PROFILE } },
        'altr:hasRepresentation': { '@id': ALT, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': LINKS_PROFILE } },
      }),
      auth: 'alice',
    });
  });
  after(async () => { await stopTestServer(); });
  let RES, ALT;

  it('self (200) carries rel="canonical" + rel="alternate" with type/formats', async () => {
    const res = await request(RES_PATH, { headers: { 'Accept-Profile': `<${CONTENT_PROFILE}>` } });
    assertStatus(res, 200);
    const link = res.headers.get('link') || '';
    assert.ok(link.includes(`<${RES}>; rel="canonical"; type="text/markdown"; formats="${CONTENT_PROFILE}"`), `canonical entry in: ${link}`);
    assert.ok(link.includes(`<${ALT}>; rel="alternate"; type="application/ld+json"; formats="${LINKS_PROFILE}"`), `alternate entry in: ${link}`);
  });

  it('406 advertises what IS available (alternate list, no profile stamp)', async () => {
    const res = await request(RES_PATH, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` } });
    assertStatus(res, 406);
    const link = res.headers.get('link') || '';
    assert.ok(link.includes('rel="canonical"'), `canonical on 406 in: ${link}`);
    assert.ok(link.includes(`formats="${LINKS_PROFILE}"`), `alternate on 406 in: ${link}`);
    assert.equal(res.headers.get('content-profile'), null);
  });

  it('bare GET advertises the declared reps (A1) AND stamps Content-Profile (R12, media match)', async () => {
    const res = await request(RES_PATH);
    assertStatus(res, 200);
    const link = res.headers.get('link') || '';
    assert.ok(link.includes('rel="canonical"'), `canonical on bare GET in: ${link}`);
    assert.ok(link.includes(`formats="${LINKS_PROFILE}"`), `alternate on bare GET in: ${link}`);
    assert.equal(res.headers.get('content-profile'), `<${CONTENT_PROFILE}>`);
  });
});

// R12 (spec 2026-07-19, DX-PROF-CONNEG R.1.2.a): an UN-negotiated response
// still identifies its representation's profile — but only when the served
// body IS the declared default representation (media-equality guard). Task
// 10's per-face .meta and Task 12's live pins rely on exactly this rule.
describe('R12: un-negotiated (bare) responses stamp the default rep profile', () => {
  const RES_PATH4 = '/frank/mem/note.md';
  const RDF_PATH4 = '/frank/data/thing.ttl';
  const BARE_PATH4 = '/frank/notes/bare.md';
  const PROFILE_A = 'https://profiles.example/frank-content';
  const TTL = '@prefix schema: <https://schema.org/>.\n<#a> schema:name "A".';
  let RES4, RDF4;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, public: true });
    await createTestPod('frank');
    const base = getBaseUrl();
    RES4 = `${base}${RES_PATH4}`;
    RDF4 = `${base}${RDF_PATH4}`;

    await request('/frank/mem/', { method: 'PUT', auth: 'frank' });
    await request(RES_PATH4, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: '# frank',
      auth: 'frank',
    });
    await request(`${RES_PATH4}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RES4,
        'altr:hasDefaultRepresentation': {
          '@id': RES4, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': PROFILE_A },
        },
      }),
      auth: 'frank',
    });

    await request('/frank/data/', { method: 'PUT', auth: 'frank' });
    await request(RDF_PATH4, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: TTL,
      auth: 'frank',
    });
    await request(`${RDF_PATH4}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RDF4,
        'altr:hasDefaultRepresentation': {
          '@id': RDF4, 'dct:format': 'text/turtle', 'dct:conformsTo': { '@id': PROFILE_A },
        },
      }),
      auth: 'frank',
    });

    await request('/frank/notes/', { method: 'PUT', auth: 'frank' });
    await request(BARE_PATH4, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: '# no meta',
      auth: 'frank',
    });
  });

  after(async () => { await stopTestServer(); });

  it('R12: bare GET (no Accept-Profile) of a resource with a declared default rep carries Content-Profile + Link rel=profile', async () => {
    const res = await request(RES_PATH4);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-profile'), `<${PROFILE_A}>`);
    assert.ok(res.headers.get('link').includes(`<${PROFILE_A}>; rel="profile"`));
  });

  it('R12: media-converted response does NOT carry the default rep profile', async () => {
    const res = await request(RDF_PATH4, { headers: { accept: 'application/ld+json' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-profile'), null);
  });

  it('R12: resource with NO .meta stays byte-identical (no stamp, no rep links)', async () => {
    const res = await request(BARE_PATH4);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-profile'), null);
    assert.doesNotMatch(res.headers.get('link') || '', /rel="profile"/);
  });

  it('R12: negotiated self-outcome still stamps (chosenProfile precedence unchanged)', async () => {
    const res = await request(RES_PATH4, { headers: { 'accept-profile': `<${PROFILE_A}>` } });
    assert.equal(res.headers.get('content-profile'), `<${PROFILE_A}>`);
  });
});
