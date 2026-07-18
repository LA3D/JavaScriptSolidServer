// Spec §4b: one --lws-config pod resource declares service pointers as data; it replaces
// --lws-profile-index and --lws-void. Read lazily + mtime-cached (a fresh pod boots before
// publish creates the resource; no restart needed once it appears).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getPodToken, getBaseUrl } from './helpers.js';

// This describe's --lws-config value is an ABSOLUTE path — the legacy
// single-podConfig convention (server.js's server-wide `podConfig`, still
// used by /.well-known/void, untouched by Task A5). Kept as-is here; do not
// repoint its VoidService/ProfileIndexService presence checks at
// /alice/lws-storage — that route resolves config through
// request.podConfigFor (A3), which is DECOUPLED from --lws-config (C2
// review fix): it always resolves at the fixed relative convention
// `profiles/pod-config.jsonld` under each storage root, regardless of what
// --lws-config names (test/lws-pod-config-per-storage.test.js pins the
// convention explicitly). See the describe below for the per-storage route.
describe('--lws-config', () => {
  let base, tok;
  before(async () => {
    await startTestServer({ lws: true, lwsConfig: '/alice/profiles/pod-config.jsonld' });
    base = getBaseUrl();
    await createTestPod('alice');
    tok = getPodToken('alice');
  });
  after(stopTestServer);

  it('/.well-known/void 303s to the configured resource once config is present', async () => {
    await request(`${base}/alice/profiles/pod-config.jsonld`, { method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: JSON.stringify({ profileIndex: '/alice/profiles/index.jsonld', void: '/alice/profiles/void.jsonld' }) });
    const r = await request(`${base}/.well-known/void`, { redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `${base}/alice/profiles/void.jsonld`);
  });
});

// Multi-tenant round (Task A5, D5): VoidService/ProfileIndexService are now
// advertised on the per-storage description (/alice/lws-storage), resolved
// via request.podConfigFor (A3) — a path RELATIVE to the storage root, not
// the absolute convention the describe above uses for the still-legacy
// /.well-known/void route. Own fixture so the two conventions don't collide.
describe('--lws-config (per-storage /:pod/lws-storage)', () => {
  let base, tok;
  before(async () => {
    await startTestServer({ lws: true, lwsConfig: 'profiles/pod-config.jsonld' });
    base = getBaseUrl();
    await createTestPod('alice');
    tok = getPodToken('alice');
  });
  after(stopTestServer);

  it('services are ABSENT before the config resource exists (no crash)', async () => {
    const sd = await (await request(`${base}/alice/lws-storage`)).json();
    assert.ok(!(sd.service || []).some(s => s.type === 'VoidService'));
  });

  it('after the config resource is written, ProfileIndexService and VoidService both appear (no restart)', async () => {
    await request(`${base}/alice/profiles/pod-config.jsonld`, { method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: JSON.stringify({ profileIndex: '/alice/profiles/index.jsonld', void: '/alice/profiles/void.jsonld' }) });
    const sd = await (await request(`${base}/alice/lws-storage`)).json();
    // Services round (R7): VoidService is now a direct per-storage pointer
    // (no 303 through the server-wide /.well-known/void route), so it's no
    // longer suppressed here. See src/lws/storage-description.js.
    const vs = (sd.service || []).find(s => s.type === 'VoidService');
    assert.ok(vs, 'VoidService must be advertised');
    assert.equal(vs.serviceEndpoint, `${base}/alice/profiles/void.jsonld`);
    assert.ok((sd.service || []).some(s => s.type === 'ProfileIndexService'));
  });
});

describe('--lws-config malformed content', () => {
  let base, tok;
  before(async () => {
    await startTestServer({ lws: true, lwsConfig: 'profiles/pod-config.jsonld' });
    base = getBaseUrl();
    await createTestPod('alice');
    tok = getPodToken('alice');
    await request(`${base}/alice/profiles/pod-config.jsonld`, { method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: 'not json{' });
  });
  after(stopTestServer);

  it('malformed config resource: services stay off, pod keeps serving (no crash)', async () => {
    const res = await request(`${base}/alice/lws-storage`);
    assert.equal(res.status, 200);
    const sd = await res.json();
    assert.ok(!(sd.service || []).some(s => s.type === 'VoidService'));
    assert.ok(!(sd.service || []).some(s => s.type === 'ProfileIndexService'));
  });
});
