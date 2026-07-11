// test/lws-implies-conneg.test.js
// Spec §4a: --lws implies the LWS-mandated content-negotiation surface (LWS core:
// "Servers MUST support content negotiation for application/lws+json, application/ld+json,
// application/json for container representations", + Turtle as sanctioned MAY). A pod
// started with --lws but WITHOUT --conneg must still negotiate.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl } from './helpers.js';

describe('--lws implies conneg (no --conneg flag)', () => {
  let base;
  before(async () => {
    await startTestServer({ lws: true });          // NB: no conneg:true
    base = getBaseUrl();
    await createTestPod('lc');
  });
  after(stopTestServer);

  it('container negotiates application/lws+json under --lws alone', async () => {
    const r = await request(`${base}/lc/`, { headers: { accept: 'application/lws+json' }, auth: 'lc' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/lws+json');
  });

  it('a stored JSON-LD resource negotiates to Turtle under --lws alone', async () => {
    await request(`${base}/lc/d.jsonld`, {
      method: 'PUT',
      headers: { 'content-type': 'application/ld+json' },
      auth: 'lc',
      body: JSON.stringify({ '@context': {}, '@id': `${base}/lc/d.jsonld`, 'http://ex/p': 'v' })
    });
    const r = await request(`${base}/lc/d.jsonld`, { headers: { accept: 'text/turtle' }, auth: 'lc' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'text/turtle');
  });
});
