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

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

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
