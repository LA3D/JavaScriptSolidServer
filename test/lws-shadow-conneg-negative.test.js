// test/lws-shadow-conneg-negative.test.js
// A2 (spec 2026-07-11 §4) negative control: --lws off must stay byte-
// identical to the pre-round shadow-wins-everything behavior. The escape
// hatch (acceptsHtml gating) is gated on `request.lwsEnabled`, so a
// non-HTML Accept on a shadowed container still gets the shadowed HTML.
// Separately, headers.js's rel="linkset" advertisement is itself inside an
// `if (lwsEnabled && resourceUrl)` block (src/ldp/headers.js:151), so with
// --lws off the rel is never emitted regardless of any suppression flag —
// pin that too, since it's the other half of "is the affordance honest".
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

describe('lws off: index.html shadow wins regardless of Accept (negative control)', () => {
  let base, CONTAINER;

  before(async () => {
    await startTestServer({ lws: false, conneg: true });
    base = getBaseUrl();
    await createTestPod('a2off');
    CONTAINER = `${base}/a2off/`;

    await request('/a2off/index.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'a2off',
      body: '<!doctype html><html><body>hi</body></html>',
    });
    await request('/a2off/x.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'a2off', body: '# x\n',
    });
  });
  after(stopTestServer);

  it('--lws off: Accept: application/lws+json on a shadowed container → 200 text/html', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'application/lws+json' }, auth: 'a2off' });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /<body>hi<\/body>/);
  });

  it('--lws off: no rel="linkset" reappears on the shadowed HTML response', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'application/lws+json' }, auth: 'a2off' });
    assertStatus(r, 200);
    assert.doesNotMatch(r.headers.get('link') || '', /rel="linkset"/);
  });

  it('--lws off: HEAD mirrors GET — still text/html, no escape', async () => {
    const h = await request(CONTAINER, { method: 'HEAD', headers: { Accept: 'application/lws+json' }, auth: 'a2off' });
    assertStatus(h, 200);
    assert.match(h.headers.get('content-type') || '', /text\/html/);
    assert.doesNotMatch(h.headers.get('link') || '', /rel="linkset"/);
  });
});
