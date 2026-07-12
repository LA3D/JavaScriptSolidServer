// test/lws-implies-conneg-negative.test.js
// NEGATIVE CONTROL (spec §1): --lws OFF, --conneg OFF → no negotiation, byte-identical upstream.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl } from './helpers.js';

describe('negative: neither --lws nor --conneg negotiates', () => {
  let base;
  before(async () => {
    await startTestServer({});
    base = getBaseUrl();
    await createTestPod('ln');
  });
  after(stopTestServer);

  it('a JSON-LD resource does NOT negotiate to Turtle with no flags', async () => {
    await request(`${base}/ln/d.jsonld`, {
      method: 'PUT',
      headers: { 'content-type': 'application/ld+json' },
      auth: 'ln',
      body: '{"@id":"x"}'
    });
    const r = await request(`${base}/ln/d.jsonld`, { headers: { accept: 'text/turtle' }, auth: 'ln' });
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/ld+json'); // unchanged
  });
});
