/**
 * lwsProfileConneg config + gating.
 *
 * Mirrors lws-storage-description-route.test.js's harness (startTestServer +
 * request from test/helpers.js) — this is a config/gating test, not a
 * capability-shape test (that's lws-storage-description-capability.test.js,
 * Task 5). Asserts the capability[] entry is actually wired end-to-end
 * through createServer -> request.lwsProfileConneg -> buildStorageDescription
 * on the real HTTP route, on by default under --lws, off when --lws is off.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { startTestServer, stopTestServer, createTestPod, request, assertStatus } from './helpers.js';

const LWS_PATH = '/.well-known/lws-storage';

// Multi-tenant round (Task A5, D5): capability[] (like the uriSpace
// capability) is a per-storage property — checked on the per-storage
// description (/alice/lws-storage), not the ServerIndex well-known, which
// carries no `capability` field at all.
describe('lwsProfileConneg gating (--lws ON, default)', () => {
  before(async () => {
    await startTestServer({ lws: true });
    await createTestPod('alice');
  });

  after(async () => {
    await stopTestServer();
  });

  it('storage description advertises the ContentNegotiation capability by default', async () => {
    const res = await request('/alice/lws-storage', { headers: { Accept: 'application/lws+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.capability), 'capability[] should be present');
    assert.ok(
      body.capability.some((c) => c.type === 'http://www.w3.org/ns/dx/connegp/profile/http'),
      'capability[] should include the connegp/profile/http type'
    );
  });
});

describe('lwsProfileConneg gating (--lws-no-profile-conneg opt-out)', () => {
  before(async () => {
    await startTestServer({ lws: true, lwsProfileConneg: false });
    await createTestPod('alice');
  });

  after(async () => {
    await stopTestServer();
  });

  it('storage description omits capability[] when explicitly disabled', async () => {
    const res = await request('/alice/lws-storage', { headers: { Accept: 'application/lws+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.strictEqual('capability' in body, false, 'capability[] should be absent when disabled');
  });
});

describe('lwsProfileConneg gating (--lws OFF)', () => {
  before(async () => {
    await startTestServer({});
  });

  after(async () => {
    await stopTestServer();
  });

  it('GET /.well-known/lws-storage returns 404 when lws is off (no capability to advertise)', async () => {
    const res = await request(LWS_PATH, { headers: { Accept: 'application/lws+json' } });
    assertStatus(res, 404);
  });
});
