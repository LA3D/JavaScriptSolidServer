// test/lws-navigator-container.test.js
// Task 5 (fork, spec 2026-07-15): navigator container view — a typed,
// WAC-filtered, server-rendered HTML listing that replaces mashlib for
// containers once --lws is on. Fixtures live under /alice/public/... so
// members inherit the pod's recursive public-read default ACL (same
// pattern as test/lws-shadow-conneg.test.js / test/lws-html-dispatch.
// test.js) — a private member then needs only its own ACL override.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, getPodToken, assertStatus, seedTyped,
} from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const NOTE_TYPE = 'https://schema.org/TextDigitalDocument';

describe('lws: navigator container view (Task 5)', () => {
  let base, CONTAINER, pod;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    const created = await createTestPod('alice');
    pod = { base, token: getPodToken('alice'), webId: created.webId };
    CONTAINER = `${base}/alice/public/stuff/`;

    // pub.md: typed PUT, inherits public-read from /alice/public/'s default.
    await seedTyped(pod, '/alice/public/stuff/pub.md', NOTE_TYPE);

    // priv.md: typed PUT, then an explicit owner-only ACL override.
    await seedTyped(pod, '/alice/public/stuff/priv.md', NOTE_TYPE);
    const privAcl = generatePrivateAcl(`${CONTAINER}priv.md`, pod.webId, false);
    const aclRes = await request('/alice/public/stuff/priv.md.acl', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: serializeAcl(privAcl),
    });
    assertStatus(aclRes, 201, 'setup: private ACL on priv.md must be written');
  });
  after(stopTestServer);

  it('anon browser GET: 200 html, typed listing, private member omitted, no mashlib marker, ?view=nav chrome', async () => {
    const r = await request(CONTAINER, { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /pub\.md/, 'public member must be listed');
    assert.match(body, /TextDigitalDocument/, 'declared-type localName badge must render');
    assert.doesNotMatch(body, /priv\.md/, 'owner-only member must be hidden (WAC-filtered)');
    assert.doesNotMatch(body, /databrowser/i, 'must not carry the mashlib marker');
    assert.match(body, /\?view=nav/, 'chrome must offer the ?view=nav navigator link');
  });

  it('Accept: application/lws+json → items[] listing unchanged (agents unaffected)', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'application/lws+json' } });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /application\/lws\+json/);
    const j = await r.json();
    assert.ok(Array.isArray(j.items), 'body must carry items[]');
    assert.ok(j.items.some((i) => i.id.endsWith('/pub.md')), 'pub.md must be listed');
    assert.ok(!j.items.some((i) => i.id.endsWith('/priv.md')), 'priv.md must stay hidden');
  });

  it('ETag: navigator response ETag differs from the lws+json listing ETag (variant suffix)', async () => {
    const navRes = await request(CONTAINER, { headers: { Accept: BROWSER_ACCEPT } });
    const jsonRes = await request(CONTAINER, { headers: { Accept: 'application/lws+json' } });
    assertStatus(navRes, 200);
    assertStatus(jsonRes, 200);
    const navEtag = navRes.headers.get('etag');
    const jsonEtag = jsonRes.headers.get('etag');
    assert.ok(navEtag, 'navigator response must carry an ETag');
    assert.ok(jsonEtag, 'lws+json response must carry an ETag');
    assert.notEqual(navEtag, jsonEtag);
    assert.match(navEtag, /-nav"$/, 'navigator ETag must carry a -nav variant suffix');
  });

  // Review fix: the -nav ETag was computed AFTER the deferred If-None-Match
  // check (inside the navigator arm), so a browser presenting a
  // previously-issued -nav ETag could never 304. Fixed by predicting the
  // -nav suffix up front, mirroring getMashlibEtag's predictive '-html'
  // pattern.
  it('navigator ETag round-trip: repeat browser GET with If-None-Match: <-nav etag> → 304', async () => {
    const first = await request(CONTAINER, { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(first, 200);
    const navEtag = first.headers.get('etag');
    assert.ok(navEtag, 'navigator response must carry an ETag');
    assert.match(navEtag, /-nav"$/, 'navigator ETag must carry a -nav variant suffix');
    const second = await request(CONTAINER, {
      headers: { Accept: BROWSER_ACCEPT, 'If-None-Match': navEtag },
    });
    assertStatus(second, 304, 'a repeat navigator GET presenting its own -nav etag must 304');
  });

  it('a -nav etag must not validate a machine lws+json conditional GET (no cross-contamination)', async () => {
    const nav = await request(CONTAINER, { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(nav, 200);
    const navEtag = nav.headers.get('etag');
    assert.ok(navEtag, 'navigator response must carry an ETag');
    const machine = await request(CONTAINER, {
      headers: { Accept: 'application/lws+json', 'If-None-Match': navEtag },
    });
    assertStatus(machine, 200, 'a machine lws+json conditional GET presenting a -nav etag must not 304');
  });
});

describe('lws: navigator container view — A2 shadow interaction', () => {
  let base, CONTAINER;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('bob');
    CONTAINER = `${base}/bob/public/withindex/`;
    await request('/bob/public/withindex/index.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'bob',
      body: '<!doctype html><html><body>bob index</body></html>',
    });
  });
  after(stopTestServer);

  it('browser Accept without ?view=nav still serves index.html (A2 shadow untouched)', async () => {
    const r = await request(CONTAINER, { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /bob index/);
  });

  it('?view=nav bypasses the shadow and serves the navigator view instead', async () => {
    const r = await request(`${CONTAINER}?view=nav`, { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.doesNotMatch(body, /bob index/, 'the shadowed index.html body must not be served');
    assert.match(body, /withindex/, 'navigator chrome shows the container name');
  });
});

describe('lws: navigator container view — non-lws server keeps mashlib unchanged', () => {
  let base, CONTAINER;

  before(async () => {
    await startTestServer({ mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('carol2');
    CONTAINER = `${base}/carol2/public/`;
    await request('/carol2/public/x.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'carol2', body: '# x\n',
    });
  });
  after(stopTestServer);

  it('browser Accept still gets the mashlib wrapper (byte-identical legacy)', async () => {
    const r = await request(CONTAINER, { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /runDataBrowser|mashlib\.min\.js/);
  });
});

// Gating regression: `?view=nav` must be inert on a non-lws pod — it has no
// meaning there, and the A2 shadow's ?view=nav escape must stay folded
// inside the SAME `request.lwsEnabled &&` guard as the rest of A2 (not a
// bare unconditional clause) so this stays true.
describe('lws: navigator container view — ?view=nav is inert without --lws', () => {
  let base, CONTAINER;

  before(async () => {
    await startTestServer({ mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('dora');
    CONTAINER = `${base}/dora/public/withindex/`;
    await request('/dora/public/withindex/index.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'dora',
      body: '<!doctype html><html><body>dora index</body></html>',
    });
  });
  after(stopTestServer);

  it('?view=nav does not bypass the index.html shadow on a non-lws pod', async () => {
    const r = await request(`${CONTAINER}?view=nav`, { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /dora index/, 'index.html must still be served — ?view=nav has no meaning off --lws');
  });
});
