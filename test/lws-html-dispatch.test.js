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

// Final-review fix I1: predictFileEtag suffixes '-nav' for a browser-shaped
// GET of an entity-viewable file BEFORE any declared text/html alternate
// exists. The early If-None-Match check (~line 464) used to compare against
// that predicted '-nav' etag and 304 unconditionally — so once the projector
// materializes the face + declares it (card bytes unchanged -> same
// stats.etag -> same predicted '-nav' etag), a browser revalidating with its
// old etag got stuck 304ing the now-obsolete entity face forever instead of
// being 303'd to the newly-live face. Fix: the early check defers for every
// lws browser-shaped request, same as it already defers for hasAcceptProfile
// — the face-dispatch arm (unconditional 303, no ETag) and the entity-face
// arm's own re-check (~line 1201) are what actually decide 304 vs 303 now.
describe('lws: face-dispatch review fix — stale -nav 304 must not mask a newly materialized face (I1)', () => {
  let base;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('finn');
    await request('/finn/public/wiki/a.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'finn', body: '# a\n',
    });
  });
  after(stopTestServer);

  it('a browser holding a -nav etag from before a face existed must 303, not 304, once the face is declared', async () => {
    // 1. No alternate declared yet -> entity face; capture its -nav ETag.
    const first = await request('/finn/public/wiki/a.md', { headers: BROWSER, auth: 'finn' });
    assertStatus(first, 200);
    const navEtag = first.headers.get('etag');
    assert.ok(navEtag && navEtag.endsWith('-nav"'), `expected a -nav ETag, got: ${navEtag}`);

    // 2. Materialize the face + declare it (same card bytes -> same stats.etag).
    await request('/finn/public/wiki/a.md.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'finn', body: '<p>a</p>',
    });
    await request('/finn/public/wiki/a.md.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'finn',
      body: repMeta(`${base}/finn/public/wiki/a.md`, `${base}/finn/public/wiki/a.md.html`),
    });

    // 3. A revalidating browser presenting the OLD -nav etag must now 303 to
    // the face, not 304 to the obsolete entity view.
    const second = await request('/finn/public/wiki/a.md', {
      headers: { ...BROWSER, 'If-None-Match': navEtag }, auth: 'finn', redirect: 'manual',
    });
    assertStatus(second, 303, 'a newly materialized face must be reachable even from a stale -nav conditional GET');
    assert.ok(second.headers.get('location').endsWith('/a.md.html'));
  });
});

// Final-review fix I3: the face dispatch (~line 1166 GET, ~line 2128 HEAD)
// trusts advertisedReps.alternates from .meta; filterReadableAlternates
// WAC-checks but never existence-checks a same-origin href, and a missing
// path's checkAccess resolves via container-default -> the dead href
// survives the authz filter -> a permanent 303 to a 404. Fix: the dispatch
// existence-checks the face href on disk before committing to the 303, and
// falls through (GET: to the entity-face arm; HEAD: same) when the target
// is gone.
describe('lws: face-dispatch review fix — a deleted face falls through, never a 303->404 loop (I3)', () => {
  let base;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('greta');
    await request('/greta/public/wiki/a.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'greta', body: '# a\n',
    });
    await request('/greta/public/wiki/a.md.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'greta', body: '<p>a</p>',
    });
    await request('/greta/public/wiki/a.md.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'greta',
      body: repMeta(`${base}/greta/public/wiki/a.md`, `${base}/greta/public/wiki/a.md.html`),
    });
    // Sanity: the face dispatch is live before the face is deleted.
    const sanity = await request('/greta/public/wiki/a.md', { headers: BROWSER, auth: 'greta', redirect: 'manual' });
    assertStatus(sanity, 303, 'setup: face dispatch must 303 before the face is deleted');

    await request('/greta/public/wiki/a.md.html', { method: 'DELETE', auth: 'greta' });
  });
  after(stopTestServer);

  it('GET: falls through to the entity face (not a 303 to a dead href)', async () => {
    const r = await request('/greta/public/wiki/a.md', { headers: BROWSER, auth: 'greta', redirect: 'manual' });
    assertStatus(r, 200, 'a deleted face must not survive as a dangling 303 target');
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /machine views/, 'must land on the entity-face metadata view, not a 404');
  });

  it('HEAD: parity with GET (falls through, no body)', async () => {
    const r = await request('/greta/public/wiki/a.md', {
      method: 'HEAD', headers: BROWSER, auth: 'greta', redirect: 'manual',
    });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  });
});
