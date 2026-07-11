// test/lws-listing-authz-negative.test.js
// NEGATIVE CONTROL (spec 2026-07-10 §1): without --lws the listing is NOT
// filtered — upstream LDP behavior byte-identical (the leak is the baseline;
// fixing it ungated would breach the fork discipline).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const PRIV = '/alice/public/listing-neg-private.jsonld';

describe('negative control: --lws off leaves the listing unfiltered', () => {
  before(async () => {
    await startTestServer({ lws: false, conneg: true });
    const alice = await createTestPod('alice');
    const base = getBaseUrl();
    await request(PRIV, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: '{}' });
    await request(`${PRIV}.acl`, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: serializeAcl(generatePrivateAcl(`${base}${PRIV}`, alice.webId, false)) });
  });
  after(async () => { await stopTestServer(); });

  it('anonymous listing still names the private member (baseline behavior pinned)', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes('listing-neg-private'));
  });
});
