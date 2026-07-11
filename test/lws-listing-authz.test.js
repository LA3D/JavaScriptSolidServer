// test/lws-listing-authz.test.js
// S1 (spec 2026-07-10 §4): the container LISTING is WAC-filtered per member
// under --lws — the same checkAccess()-and-drop discipline as /types/*
// (src/lws/authorized-resources.js: "the filter IS the authz boundary").
// Hide, never 401 — no discovery oracle. Closes the probe-#3 existence leak.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const PUB = '/alice/public/listing-open.jsonld';
const PRIV = '/alice/public/listing-private.jsonld';

describe('WAC-filtered container listing (--lws)', () => {
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    const alice = await createTestPod('alice');
    const base = getBaseUrl();
    await request(PUB, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@id': `${base}${PUB}`, note: 'open' }) });
    await request(PRIV, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@id': `${base}${PRIV}`, note: 'private' }) });
    // Owner-only resource ACL overrides the folder's inherited public-read
    // (resource ACL wins — src/wac/checker.js findApplicableAcl).
    const aclRes = await request(`${PRIV}.acl`, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: serializeAcl(generatePrivateAcl(`${base}${PRIV}`, alice.webId, false)) });
    assert.ok([200, 201, 204].includes(aclRes.status));
  });
  after(async () => { await stopTestServer(); });

  it('anonymous LDP listing hides the unreadable member (ldp:contains)', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes('listing-open'));
    assert.ok(!body.includes('listing-private'));
  });

  it('anonymous lws+json items[] hides it too', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/lws+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(!body.includes('listing-private'));
  });

  it('the owner still sees both members', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' }, auth: 'alice' });
    const body = await r.text();
    assert.ok(body.includes('listing-open'));
    assert.ok(body.includes('listing-private'));
  });

  it('no oracle: the hidden member still answers 401/403 directly (not 404-scrubbed here — existence policy unchanged)', async () => {
    const r = await request(PRIV, { headers: { Accept: 'application/ld+json' } });
    assert.ok([401, 403].includes(r.status));
  });
});
