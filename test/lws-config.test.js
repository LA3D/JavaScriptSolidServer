// Spec §4b: one --lws-config pod resource declares service pointers as data; it replaces
// --lws-profile-index and --lws-void. Read lazily + mtime-cached (a fresh pod boots before
// publish creates the resource; no restart needed once it appears).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getPodToken, getBaseUrl } from './helpers.js';

describe('--lws-config', () => {
  let base, tok;
  before(async () => {
    await startTestServer({ lws: true, lwsConfig: '/alice/profiles/pod-config.jsonld' });
    base = getBaseUrl();
    await createTestPod('alice');
    tok = getPodToken('alice');
  });
  after(stopTestServer);

  it('services are ABSENT before the config resource exists (no crash)', async () => {
    const sd = await (await request(`${base}/.well-known/lws-storage`)).json();
    assert.ok(!(sd.service || []).some(s => s.type === 'VoidService'));
  });

  it('after the config resource is written, services appear (no restart)', async () => {
    await request(`${base}/alice/profiles/pod-config.jsonld`, { method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: JSON.stringify({ profileIndex: '/alice/profiles/index.jsonld', void: '/alice/profiles/void.jsonld' }) });
    const sd = await (await request(`${base}/.well-known/lws-storage`)).json();
    assert.ok((sd.service || []).some(s => s.type === 'VoidService' && s.serviceEndpoint.endsWith('/.well-known/void')));
    assert.ok((sd.service || []).some(s => s.type === 'ProfileIndexService'));
  });

  it('/.well-known/void 303s to the configured resource once config is present', async () => {
    const r = await request(`${base}/.well-known/void`, { redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `${base}/alice/profiles/void.jsonld`);
  });
});
