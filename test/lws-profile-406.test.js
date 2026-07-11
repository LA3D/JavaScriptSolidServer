// test/lws-profile-406.test.js
// F5 (spec 2026-07-11 §3): the profile-406 speaks the same RFC 9457
// problem+json grammar as the media-406 (F3, nonRdfNotAcceptable) and LISTS
// the profiles that would conform — at all three sites (file GET, container
// listing, HEAD parity). Fixture pattern copied from
// test/lws-profile-conneg-get.test.js / lws-profile-conneg-head-container.test.js
// (client-managed .meta PUT declaring altr: representations).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus } from './helpers.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';
const CONTENT_PROFILE = 'https://ex.org/profiles/content';
const ALT_PROFILE = 'https://ex.org/profiles/links';
const CONTAINER_ALT_PROFILE = 'https://ex.org/profiles/container-links';
const UNKNOWN_PROFILE = 'https://ex.org/profiles/nope';

describe('lws: unified profile-406 (file GET + container + HEAD parity)', () => {
  let base, RES, ALT, CONTAINER;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    await createTestPod('f5');
    RES = `${base}/f5/m.md`;
    ALT = `${base}/f5/m.links.jsonld`;
    CONTAINER = `${base}/f5/`;

    await request('/f5/m.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'f5', body: '# m\n',
    });
    // Declare a representation set on m.md via .meta (altr:), same shape the
    // conneg suite uses (test/lws-profile-conneg-get.test.js beforeEach).
    await request('/f5/m.md.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'f5',
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RES,
        'altr:hasDefaultRepresentation': {
          '@id': RES, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': CONTENT_PROFILE },
        },
        'altr:hasRepresentation': {
          '@id': ALT, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': ALT_PROFILE },
        },
      }),
    });

    // Container also declares its own representation set — TWO profiles
    // (default + an alternate) so the 406 detail's join is actually
    // exercised (item 8 hygiene: pins conforming.join(', ') across >1 entry).
    await request('/f5/.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'f5',
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': CONTAINER,
        'altr:hasDefaultRepresentation': {
          '@id': CONTAINER, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': CONTENT_PROFILE },
        },
        'altr:hasRepresentation': {
          '@id': `${base}/f5/index.links.jsonld`, 'dct:format': 'application/ld+json',
          'dct:conformsTo': { '@id': CONTAINER_ALT_PROFILE },
        },
      }),
    });

    // No .meta at all — proves the "(none declared)" detail wording.
    await request('/f5/plain.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'f5', body: '# plain\n',
    });
  });
  after(stopTestServer);

  it('file GET: unknown Accept-Profile → 406 problem+json listing conforming profiles', async () => {
    const r = await request(RES, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` }, auth: 'f5' });
    assertStatus(r, 406);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/problem+json');
    const p = await r.json();
    assert.equal(p.type, 'about:blank');
    assert.equal(p.title, 'Not Acceptable');
    assert.equal(p.status, 406);
    assert.match(p.detail, /https:\/\/ex\.org\/profiles\/content/);
    assert.equal(p.instance, RES);
  });

  it('file GET: no declared representations → 406 detail says "(none declared)"', async () => {
    const r = await request(`${base}/f5/plain.md`, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` }, auth: 'f5' });
    assertStatus(r, 406);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/problem+json');
    const p = await r.json();
    assert.match(p.detail, /\(none declared\)/);
  });

  it('file GET 406 still keeps the existing Link (alternate-list) + Vary headers', async () => {
    const r = await request(RES, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` }, auth: 'f5' });
    assertStatus(r, 406);
    assert.match(r.headers.get('link') || '', /rel="alternate"/);
    assert.match(r.headers.get('vary') || '', /Accept-Profile/);
  });

  it('container listing: unknown Accept-Profile → 406 problem+json listing conforming profiles', async () => {
    const r = await request(CONTAINER, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` }, auth: 'f5' });
    assertStatus(r, 406);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/problem+json');
    const p = await r.json();
    assert.equal(p.type, 'about:blank');
    assert.equal(p.title, 'Not Acceptable');
    assert.equal(p.status, 406);
    // Two profiles are declared on /f5/.meta (default + an alternate) —
    // both must appear, pinning conforming.join(', ') across >1 entry
    // (item 8 hygiene: a single-profile fixture can't distinguish a join
    // from a bare interpolation).
    assert.match(p.detail, /https:\/\/ex\.org\/profiles\/content/);
    assert.match(p.detail, /https:\/\/ex\.org\/profiles\/container-links/);
    assert.equal(p.instance, CONTAINER);
  });

  it('HEAD parity: same problem+json content-type, empty body', async () => {
    const getRes = await request(RES, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` }, auth: 'f5' });
    const headRes = await request(RES, { method: 'HEAD', headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` }, auth: 'f5' });
    assertStatus(headRes, 406);
    // Literal check (item 8 hygiene) — GET-equality alone would also pass
    // if BOTH sides regressed to the same wrong content-type.
    assert.equal(headRes.headers.get('content-type').split(';')[0], 'application/problem+json');
    assert.equal(headRes.headers.get('content-type').split(';')[0], getRes.headers.get('content-type').split(';')[0]);
    assert.equal(await headRes.text(), '');
  });

  it('HEAD container parity: same problem+json content-type, empty body', async () => {
    const getRes = await request(CONTAINER, { headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` }, auth: 'f5' });
    const headRes = await request(CONTAINER, { method: 'HEAD', headers: { 'Accept-Profile': `<${UNKNOWN_PROFILE}>` }, auth: 'f5' });
    assertStatus(headRes, 406);
    // Literal check (item 8 hygiene) — see the file-GET HEAD-parity test above.
    assert.equal(headRes.headers.get('content-type').split(';')[0], 'application/problem+json');
    assert.equal(headRes.headers.get('content-type').split(';')[0], getRes.headers.get('content-type').split(';')[0]);
    assert.equal(await headRes.text(), '');
  });
});
