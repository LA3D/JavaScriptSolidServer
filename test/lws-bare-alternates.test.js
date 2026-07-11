// test/lws-bare-alternates.test.js
// A1 (spec §4): declared representations are advertised on the BARE 200 —
// no Accept-Profile needed. A resource whose .meta declares altr: default +
// alternates carries rel="canonical"/"alternate" Links on plain GET/HEAD;
// a resource with NO .meta pays only a storage.exists() and gets no new
// rels; --lws off is byte-identical to upstream (negative control).
// Fixture shape copied from test/lws-profile-406.test.js (client-managed
// .meta PUT declaring altr: representations).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl } from './helpers.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';
const CONTENT_PROFILE = 'https://ex.org/profiles/content';
const ALT_PROFILE = 'https://ex.org/profiles/links';

function repMeta(id, alt, container = false) {
  return JSON.stringify({
    '@context': { altr: ALTR, dct: DCT },
    '@id': id,
    'altr:hasDefaultRepresentation': {
      '@id': id, 'dct:format': container ? 'application/ld+json' : 'text/markdown',
      'dct:conformsTo': { '@id': CONTENT_PROFILE },
    },
    ...(alt ? {
      'altr:hasRepresentation': {
        '@id': alt, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': ALT_PROFILE },
      },
    } : {}),
  });
}

describe('lws: alternates advertised on the bare 200 (A1)', () => {
  let base, RES, ALT, CONTAINER;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    await createTestPod('a1');
    RES = `${base}/a1/m.md`;
    ALT = `${base}/a1/m.links.jsonld`;
    CONTAINER = `${base}/a1/`;

    await request('/a1/m.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'a1', body: '# m\n',
    });
    await request('/a1/m.md.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'a1',
      body: repMeta(RES, ALT),
    });
    // Container declares its own representation set on /a1/.meta.
    await request('/a1/.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'a1',
      body: repMeta(CONTAINER, null, true),
    });
    // No .meta at all — the zero-cost path.
    await request('/a1/plain.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'a1', body: '# plain\n',
    });
  });
  after(stopTestServer);

  it('bare GET (no Accept-Profile) carries canonical+alternate Links', async () => {
    const r = await request(RES, { auth: 'a1' });
    assert.equal(r.status, 200);
    const link = r.headers.get('link') || '';
    assert.match(link, /rel="canonical"/);
    assert.match(link, /rel="alternate"/);
    assert.match(link, /formats="/);
  });

  it('bare HEAD carries the SAME canonical/alternate Links as GET (RFC 9110 §9.3.2)', async () => {
    const g = await request(RES, { auth: 'a1' });
    const h = await request(RES, { method: 'HEAD', auth: 'a1' });
    assert.equal(h.status, 200);
    assert.match(h.headers.get('link') || '', /rel="canonical"/);
    assert.match(h.headers.get('link') || '', /rel="alternate"/);
    assert.equal(h.headers.get('link'), g.headers.get('link'));
  });

  it('bare container GET carries the canonical Link from /a1/.meta', async () => {
    const r = await request(CONTAINER, { auth: 'a1' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('link') || '', /rel="canonical"/);
  });

  it('bare container HEAD matches container GET', async () => {
    const g = await request(CONTAINER, { auth: 'a1' });
    const h = await request(CONTAINER, { method: 'HEAD', auth: 'a1' });
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('link'), g.headers.get('link'));
    assert.match(h.headers.get('link') || '', /rel="canonical"/);
  });

  it('a resource with NO .meta gets no canonical/alternate rels (zero-cost path)', async () => {
    const r = await request(`${base}/a1/plain.md`, { auth: 'a1' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.headers.get('link') || '', /rel="(canonical|alternate)"/);
  });

  it('negotiated path unchanged: Accept-Profile self still stamps Content-Profile + the same rep Links', async () => {
    const r = await request(RES, { headers: { 'Accept-Profile': `<${CONTENT_PROFILE}>` }, auth: 'a1' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-profile'), `<${CONTENT_PROFILE}>`);
    assert.match(r.headers.get('link') || '', /rel="canonical"/);
    assert.match(r.headers.get('link') || '', /rel="alternate"/);
  });
});

describe('lws off: bare GET carries no canonical/alternate rels (negative control)', () => {
  let base, RES, ALT;

  before(async () => {
    await startTestServer({ lws: false, conneg: true });
    base = getBaseUrl();
    await createTestPod('a1off');
    RES = `${base}/a1off/m.md`;
    ALT = `${base}/a1off/m.links.jsonld`;
    await request('/a1off/m.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'a1off', body: '# m\n',
    });
    await request('/a1off/m.md.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'a1off',
      body: repMeta(RES, ALT),
    });
  });
  after(stopTestServer);

  it('--lws off: bare GET carries no canonical/alternate rels even with a .meta present', async () => {
    const r = await request(RES, { auth: 'a1off' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.headers.get('link') || '', /rel="(canonical|alternate)"/);
  });

  it('--lws off: bare HEAD carries no canonical/alternate rels either', async () => {
    const r = await request(RES, { method: 'HEAD', auth: 'a1off' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.headers.get('link') || '', /rel="(canonical|alternate)"/);
  });
});
