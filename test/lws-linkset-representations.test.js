// test/lws-linkset-representations.test.js
// Integration test: Task 8 item 1 — the served RFC 9264 linkset
// (Accept: application/linkset+json) now carries `canonical`/`alternate`
// members from the resource's .meta altr: declarations (src/lws/linkset.js
// already supported a `representations` option since Task 4 — the GET
// call sites just weren't passing it). Covers both call sites: the file
// linkset branch and the container linkset branch in
// src/handlers/resource.js. The advertisement is emitted whenever the
// linkset is served, independent of Accept-Profile (no negotiation gate).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';

describe('Linkset representation advertisement — file', () => {
  const RES_PATH = '/alice/mem/mem-a.md';
  const ALT_PATH = '/alice/mem/mem-a.links.jsonld';
  const CONTENT_PROFILE = 'https://profiles.example/content';
  const LINKS_PROFILE = 'https://profiles.example/links';
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

  it('GET linkset+json → body carries canonical (default) + alternate entries', async () => {
    const res = await request(RES_PATH, { headers: { Accept: 'application/linkset+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    const link = body.linkset[0];
    assert.deepEqual(link.canonical, [{ href: RES, type: 'text/markdown', formats: CONTENT_PROFILE }]);
    assert.deepEqual(link.alternate, [{ href: ALT, type: 'application/ld+json', formats: LINKS_PROFILE }]);
  });

  it('advertisement is emitted with no Accept-Profile at all (unconditional, not gated on negotiation)', async () => {
    const res = await request(RES_PATH, { headers: { Accept: 'application/linkset+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.ok(body.linkset[0].canonical, 'canonical present without any Accept-Profile header');
  });
});

describe('Linkset representation advertisement — container', () => {
  const CONTAINER_PATH = '/bob/mem/';
  const ALT_PATH = '/bob/mem-alt.jsonld';
  const DEFAULT_PROFILE = 'https://profiles.example/container-default';
  const ALT_PROFILE = 'https://profiles.example/container-alt';
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

  it('GET container linkset+json → body carries canonical + alternate entries', async () => {
    const res = await request(CONTAINER_PATH, { headers: { Accept: 'application/linkset+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    const link = body.linkset[0];
    assert.deepEqual(link.canonical, [{ href: CONTAINER, type: 'application/ld+json', formats: DEFAULT_PROFILE }]);
    assert.deepEqual(link.alternate, [{ href: ALT, type: 'application/ld+json', formats: ALT_PROFILE }]);
  });
});

describe('Linkset representation advertisement — regression (no .meta altr declared)', () => {
  const RES_PATH = '/erin/notes/plain.md';
  const CONTAINER_PATH = '/erin/notes/';

  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('erin');
    await request(CONTAINER_PATH, { method: 'PUT', auth: 'erin' });
    await request(RES_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: '# plain',
      auth: 'erin',
    });
  });

  after(async () => { await stopTestServer(); });

  it('file linkset with no altr declarations → no canonical/alternate keys', async () => {
    const res = await request(RES_PATH, { headers: { Accept: 'application/linkset+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.equal('canonical' in body.linkset[0], false);
    assert.equal('alternate' in body.linkset[0], false);
  });

  it('container linkset with no altr declarations → no canonical/alternate keys', async () => {
    const res = await request(CONTAINER_PATH, { headers: { Accept: 'application/linkset+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.equal('canonical' in body.linkset[0], false);
    assert.equal('alternate' in body.linkset[0], false);
  });
});
