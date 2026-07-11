// test/lws-shadow-conneg.test.js
// A2 (spec 2026-07-11 §4): index.html shadows the container listing only for
// requests that can accept an HTML answer. Under --lws, a non-HTML Accept
// escapes the shadow and reaches the REAL listing branch — lws+json/
// linkset/turtle/quads all become reachable there (including the WAC filter
// and A1 alternates from resource.js:329+), and rel="linkset" is no longer
// a false affordance on the shadowed HTML response either. Browsers (no
// Accept, or a browser-style compound Accept with */*) are unaffected —
// they still get the shadowed HTML, exactly as before this task.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';
const CONTENT_PROFILE = 'https://ex.org/profiles/shadow-content';
const ALT_PROFILE = 'https://ex.org/profiles/shadow-links';

// A1 fixture (shape copied from test/lws-bare-alternates.test.js repMeta).
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

describe('lws: index.html shadow honors non-HTML Accepts (A2)', () => {
  let base, CONTAINER;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    await createTestPod('a2');
    CONTAINER = `${base}/a2/`;

    await request('/a2/index.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'a2',
      body: '<!doctype html><html><body>hi</body></html>',
    });
    await request('/a2/x.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'a2', body: '# x\n',
    });
  });
  after(stopTestServer);

  it('Accept: text/html → 200 html (browsers unchanged)', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'text/html' }, auth: 'a2' });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /<body>hi<\/body>/);
  });

  it('browser-style Accept with */* → 200 html', async () => {
    const r = await request(CONTAINER, { headers: { Accept: BROWSER_ACCEPT }, auth: 'a2' });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  });

  it('Accept: application/lws+json → 200 items[] listing (the escape)', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'application/lws+json' }, auth: 'a2' });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /application\/lws\+json/);
    const j = await r.json();
    assert.ok(Array.isArray(j.items), 'body must carry items[]');
    assert.ok(j.items.some((i) => i.id.endsWith('/a2/x.md')), 'x.md must be listed');
  });

  it('Accept: text/turtle → 200 membership graph with ldp:contains triples', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'text/turtle' }, auth: 'a2' });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/turtle/);
    const body = await r.text();
    assert.match(body, /ldp#contains|ldp:contains/);
    assert.match(body, /x\.md/);
  });

  it('Accept: application/linkset+json → 200 linkset (rel no longer a false affordance)', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'application/linkset+json' }, auth: 'a2' });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /application\/linkset\+json/);
    const body = await r.json();
    assert.ok(Array.isArray(body.linkset), 'body must carry a linkset[] array');
    assert.equal(body.linkset[0].anchor, CONTAINER);
  });

  it('shadowed container GET (html) now ADVERTISES rel="linkset" again', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'text/html' }, auth: 'a2' });
    assertStatus(r, 200);
    assert.match(r.headers.get('link') || '', /rel="linkset"/);
  });

  it('HEAD parity: lws+json HEAD on shadowed container reports lws+json', async () => {
    const h = await request(CONTAINER, { method: 'HEAD', headers: { Accept: 'application/lws+json' }, auth: 'a2' });
    assertStatus(h, 200);
    assert.match(h.headers.get('content-type') || '', /application\/lws\+json/);
  });

  it('HEAD parity: text/html HEAD on shadowed container still reports text/html', async () => {
    const h = await request(CONTAINER, { method: 'HEAD', headers: { Accept: 'text/html' }, auth: 'a2' });
    assertStatus(h, 200);
    assert.match(h.headers.get('content-type') || '', /text\/html/);
    assert.match(h.headers.get('link') || '', /rel="linkset"/);
  });
});

// Task 13 hygiene item 7(a): the shadow-escape branch (A2) and the WAC
// listing filter (S1) are independent mechanisms — pin that they compose.
// A container with index.html AND a mixed-visibility membership: the
// anonymous escape listing must still hide the owner-only member (the
// escape must not be a WAC bypass).
describe('lws: shadow-escape + WAC compose (item 7a hygiene)', () => {
  let CONTAINER;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    const base = getBaseUrl();
    const carol = await createTestPod('carol');
    CONTAINER = `${base}/carol/public/`;

    await request('/carol/public/index.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'carol',
      body: '<!doctype html><html><body>hi</body></html>',
    });
    // /carol/public/ already inherits the pod's public-read default ACL
    // (generatePublicFolderAcl, written at pod-creation time).
    await request('/carol/public/open.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'carol', body: '# open\n',
    });
    await request('/carol/public/secret.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'carol', body: '# secret\n',
    });
    // Owner-only resource ACL overrides the inherited public-read default.
    const privateAcl = generatePrivateAcl(`${CONTAINER}secret.md`, carol.webId, false);
    const aclRes = await request('/carol/public/secret.md.acl', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'carol',
      body: serializeAcl(privateAcl),
    });
    assertStatus(aclRes, 201, 'setup: private ACL on secret.md must be written');
  });
  after(stopTestServer);

  it('anonymous escape listing (Accept: application/lws+json) omits the owner-only member', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'application/lws+json' } });
    assertStatus(r, 200);
    const body = await r.json();
    assert.ok(body.items.some((i) => i.id.endsWith('/open.md')), 'the public member must be listed');
    assert.ok(!body.items.some((i) => i.id.endsWith('/secret.md')), 'the owner-only member must be hidden');
  });
});

// Task 13 hygiene item 7(b): the escape path must run the SAME rendering
// branch as an unshadowed container, not a special-cased one — proven by
// comparing an escaped listing to an unshadowed twin container with
// identical A1 (.meta) declarations. A follow-up GET of the member (a
// plain file, never shadowed) must still carry its own alternate Links.
describe('lws: shadow-escape + A1 compose (item 7b hygiene)', () => {
  let SHADOWED, UNSHADOWED, MEMBER;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    const base = getBaseUrl();
    await createTestPod('dan');
    SHADOWED = `${base}/dan/shadowed/`;
    UNSHADOWED = `${base}/dan/unshadowed/`;
    MEMBER = `${SHADOWED}m.md`;

    await request('/dan/shadowed/m.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'dan', body: '# m\n',
    });
    await request('/dan/shadowed/index.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'dan',
      body: '<!doctype html><html><body>hi</body></html>',
    });
    await request('/dan/shadowed/.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'dan',
      body: repMeta(SHADOWED, null, true),
    });
    await request('/dan/shadowed/m.md.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'dan',
      body: repMeta(MEMBER, `${SHADOWED}m.links.jsonld`),
    });

    // Unshadowed twin: same member + same container-level .meta, no index.html.
    await request('/dan/unshadowed/m.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'dan', body: '# m\n',
    });
    await request('/dan/unshadowed/.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'dan',
      body: repMeta(UNSHADOWED, null, true),
    });
  });
  after(stopTestServer);

  it('escaped listing matches the unshadowed twin\'s container-level Links; the member keeps its alternate Links', async () => {
    const escaped = await request(SHADOWED, { headers: { Accept: 'application/lws+json' }, auth: 'dan' });
    const twin = await request(UNSHADOWED, { headers: { Accept: 'application/lws+json' }, auth: 'dan' });
    assertStatus(escaped, 200);
    assertStatus(twin, 200);

    // Normalize the container-specific URL out of each Link header so the
    // two can be compared for structural equality (same rels, same shape).
    const normalize = (link, containerUrl) => (link || '').split(containerUrl).join('<CONTAINER>');
    assert.equal(
      normalize(escaped.headers.get('link'), SHADOWED),
      normalize(twin.headers.get('link'), UNSHADOWED),
      'the escape path must run the same container-level rendering branch as an unshadowed container'
    );
    assert.match(escaped.headers.get('link') || '', /rel="canonical"/);

    // A plain file is never shadowed — its own A1 alternates still advertise.
    const memberGet = await request(MEMBER, { auth: 'dan' });
    assertStatus(memberGet, 200);
    assert.match(memberGet.headers.get('link') || '', /rel="alternate"/);
  });
});
