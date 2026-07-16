// Task A8 (multi-tenant round): the referent resolver (resolveReferentTarget
// in src/handlers/resource.js, plus the auth-gate pre-check in
// src/auth/middleware.js) must read the OWNING storage's uriSpaces
// (request.podConfigFor(storageRootFor(...))), not the single global
// request.podConfig — otherwise a second tenant's uriSpaces are invisible
// (or worse, tenants leak into each other) once pod-config goes per-storage
// (A3). No --lws-config flag is passed here: the per-storage config path is
// the fixed convention (<root>profiles/pod-config.jsonld, decoupled from
// --lws-config per 20f541d), so a bare `{ lws: true }` server is enough.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, createTestPod, getPodToken, getBaseUrl, request, assertStatus, assertHeaderContains } from './helpers.js';

describe('referent resolver reads the owning storage\'s uriSpaces', () => {
  let base, aliceTok;
  before(async () => {
    await startTestServer({ lws: true });
    base = getBaseUrl();
    await createTestPod('alice');
    aliceTok = getPodToken('alice');
    await createTestPod('bob'); // second tenant, deliberately left WITHOUT a pod-config

    // alice's own per-storage pod-config — fixed convention path, no
    // --lws-config flag involved.
    await request(`${base}/alice/profiles/pod-config.jsonld`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceTok}`, 'content-type': 'application/ld+json' },
      body: JSON.stringify({
        uriSpaces: [{ pathPrefix: '/alice/id/', container: '/alice/wiki/', suffix: '.md' }],
      }),
    });

    // seed the real, PUBLIC-READ target the minted name resolves to
    await request(`${base}/alice/wiki/a.md`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceTok}`, 'content-type': 'text/markdown' },
      body: '# Alpha\n',
    });
    const { generatePublicReadAcl, serializeAcl } = await import('../src/wac/parser.js');
    await request(`${base}/alice/wiki/a.md.acl`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${aliceTok}`, 'content-type': 'application/ld+json' },
      body: serializeAcl(generatePublicReadAcl(`${base}/alice/wiki/a.md`)),
    });
  });
  after(stopTestServer);

  it('anon GET /alice/id/a 303s to /alice/wiki/a.md, reading alice\'s own uriSpaces', async () => {
    const res = await request('/alice/id/a', { redirect: 'manual' });
    assertStatus(res, 303);
    assertHeaderContains(res, 'location', '/alice/wiki/a.md');
    assertHeaderContains(res, 'link', 'rel="canonical"');
  });

  it('no-oracle: GET /alice/id/nonexistent 404s (name resolves per prefix, target does not exist)', async () => {
    const res = await request('/alice/id/nonexistent', { redirect: 'manual' });
    assertStatus(res, 404);
  });

  // Neither of the two cases below matches any declared uriSpace prefix, so
  // the auth-gate pre-check's exemption never fires and the request falls
  // through to the ordinary blanket WAC check — which, for an unauthenticated
  // request against a path with no applicable grant, denies with 401 (same
  // established precedent as the "--lws off" negative control in
  // test/lws-referent-resolver.test.js: "the one invariant this negative
  // control actually needs is 'never 303'"). The point of both assertions is
  // that per-storage scoping never manufactures a spurious 303 — the exact
  // non-303 status is incidental, pre-existing WAC behavior this task doesn't
  // touch.
  it('per-storage scoping: /bob/id/a is NOT resolved by alice\'s uriSpaces (bob has no pod-config) — never a spurious 303', async () => {
    const res = await request('/bob/id/a', { redirect: 'manual' });
    assert.notEqual(res.status, 303);
    assertStatus(res, 401);
  });

  it('a name with no owning storage at all (unmarked first segment) never resolves to a spurious 303', async () => {
    const res = await request('/nobody/id/a', { redirect: 'manual' });
    assert.notEqual(res.status, 303);
    assertStatus(res, 401);
  });
});
