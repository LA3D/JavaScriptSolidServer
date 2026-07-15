// test/lws-html-dispatch.test.js
// Task 4 (fork, spec 2026-07-15): text/html face dispatch — a browser-shaped
// GET/HEAD of a bare resource name that has a declared text/html alternate
// (advertised via altr: in its .meta) gets a 303 to that face, inserted
// BEFORE the mashlib intercept. ?view=nav opts out (navigator/entity path,
// later task). --lws only: non-lws behavior stays byte-identical (mashlib
// wrapper). Fixture (repMeta) copied from test/lws-bare-alternates.test.js,
// with the alternate given dct:format "text/html".
//
// Resources live under /alice/public/ so the resource inherits the pod's
// default recursive public-read ACL (see test/lws-alternate-authz-filter.
// test.js) — needed so case 5 (anon GET) actually exercises the alternate's
// WAC filter rather than just 401ing on the resource itself.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';
const CONTENT_PROFILE = 'https://ex.org/profiles/content';
const HTML_PROFILE = 'https://ex.org/profiles/html';

const BROWSER = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

function repMeta(id, alt) {
  return JSON.stringify({
    '@context': { altr: ALTR, dct: DCT },
    '@id': id,
    'altr:hasDefaultRepresentation': {
      '@id': id, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': CONTENT_PROFILE },
    },
    ...(alt ? {
      'altr:hasRepresentation': {
        '@id': alt, 'dct:format': 'text/html', 'dct:conformsTo': { '@id': HTML_PROFILE },
      },
    } : {}),
  });
}

describe('lws: text/html face dispatch (303 to declared alternate)', () => {
  let base, alice, RES, FACE;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    alice = await createTestPod('alice');
    RES = `${base}/alice/public/wiki/a.md`;
    FACE = `${base}/alice/public/wiki/a.md.html`;

    await request('/alice/public/wiki/a.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'alice', body: '# a\n',
    });
    await request('/alice/public/wiki/a.md.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'alice', body: '<p>a</p>',
    });
    await request('/alice/public/wiki/a.md.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: repMeta(RES, FACE),
    });
  });
  after(stopTestServer);

  it('1. GET with browser Accept -> 303 to the declared html alternate', async () => {
    const r = await request('/alice/public/wiki/a.md', {
      headers: BROWSER, auth: 'alice', redirect: 'manual',
    });
    assertStatus(r, 303);
    assert.ok(r.headers.get('location').endsWith('/a.md.html'));
  });

  it('2. GET with browser Accept + ?view=nav -> NOT 303 (opt-out; current mashlib behavior until Task 6)', async () => {
    const r = await request('/alice/public/wiki/a.md?view=nav', {
      headers: BROWSER, auth: 'alice', redirect: 'manual',
    });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  });

  it('3. GET with Accept: application/ld+json -> unchanged (no 303; RDF conneg)', async () => {
    const r = await request('/alice/public/wiki/a.md', {
      headers: { Accept: 'application/ld+json' }, auth: 'alice', redirect: 'manual',
    });
    assert.notEqual(r.status, 303);
  });

  it('4. HEAD with browser Accept -> 303 (HEAD parity)', async () => {
    const r = await request('/alice/public/wiki/a.md', {
      method: 'HEAD', headers: BROWSER, auth: 'alice', redirect: 'manual',
    });
    assertStatus(r, 303);
    assert.ok(r.headers.get('location').endsWith('/a.md.html'));
  });

  it('5. Private face: tightened alternate ACL -> anon GET gets no 303 (alternate WAC-filtered)', async () => {
    const privateAcl = generatePrivateAcl(FACE, alice.webId, false);
    const aclRes = await request('/alice/public/wiki/a.md.html.acl', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: serializeAcl(privateAcl),
    });
    assertStatus(aclRes, 201, 'setup: private ACL on the alternate must be written');

    // The bare resource itself stays public (inherited default), so this
    // proves the alternate's absence from advertisedReps, not a blanket 401.
    const r = await request('/alice/public/wiki/a.md', { headers: BROWSER, redirect: 'manual' });
    assertStatus(r, 200);
    assert.notEqual(r.status, 303);
  });
});

describe('lws off: browser Accept still gets the mashlib wrapper (byte-identical legacy)', () => {
  before(async () => {
    await startTestServer({ conneg: true, mashlibCdn: true });
    await createTestPod('alice');
    await request('/alice/wiki/a.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'alice', body: '# a\n',
    });
  });
  after(stopTestServer);

  it('6. --lws off: GET with browser Accept -> 200 mashlib wrapper, not 303', async () => {
    const r = await request('/alice/wiki/a.md', { headers: BROWSER, auth: 'alice', redirect: 'manual' });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  });
});
