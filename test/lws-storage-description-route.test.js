/**
 * LWS Storage Description Route Tests
 *
 * Tests GET /.well-known/lws-storage and GET /:pod/lws-storage when --lws
 * is enabled/disabled. Routes are additive only — default behavior
 * (lws: false) must not change.
 *
 * Multi-tenant round (Task A5, D5): /.well-known/lws-storage is now a
 * SERVER INDEX (`type: 'ServerIndex'`) — a WAC-filtered roster of every
 * storage this pod hosts — not a single `Storage` description. The
 * per-storage `Storage` document a pre-multi-tenant client expected at the
 * well-known path now lives at /:pod/lws-storage, one per tenant.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  startTestServer,
  stopTestServer,
  createTestPod,
  request,
  assertStatus,
  assertHeaderContains
} from './helpers.js';

const LWS_PATH = '/.well-known/lws-storage';

describe('LWS Storage Description Route (--lws ON)', () => {
  before(async () => {
    await startTestServer({ lws: true });
    await createTestPod('alice');
  });

  after(async () => {
    await stopTestServer();
  });

  it('GET returns 200 with application/lws+json', async () => {
    const res = await request(LWS_PATH, {
      headers: { Accept: 'application/lws+json' }
    });
    assertStatus(res, 200);
    assertHeaderContains(res, 'content-type', 'application/lws+json');
  });

  it('body is a ServerIndex roster, not a Storage (D5 — the multi-tenant shape change)', async () => {
    const res = await request(LWS_PATH, {
      headers: { Accept: 'application/lws+json' }
    });
    const body = await res.json();
    assert.strictEqual(body['@context'], 'https://www.w3.org/ns/lws/v1', '@context mismatch');
    assert.strictEqual(body.type, 'ServerIndex', 'type mismatch');
    assert.ok(Array.isArray(body.storage), 'storage must be an array');
    const alice = body.storage.find(s => s.id.endsWith('/alice/'));
    assert.ok(alice, 'ServerIndex must list the alice storage');
    assert.ok(alice.storageDescription.endsWith('/alice/lws-storage'),
      `alice storageDescription should end with /alice/lws-storage, got: ${alice.storageDescription}`);
  });

  it('id ends with /', async () => {
    const res = await request(LWS_PATH, {
      headers: { Accept: 'application/lws+json' }
    });
    const body = await res.json();
    assert.ok(body.id.endsWith('/'), `id should end with /, got: ${body.id}`);
  });

  it('PUT returns 405', async () => {
    const res = await request(LWS_PATH, { method: 'PUT' });
    assertStatus(res, 405);
  });

  it('POST returns 405', async () => {
    const res = await request(LWS_PATH, { method: 'POST' });
    assertStatus(res, 405);
  });

  it('PATCH returns 405', async () => {
    const res = await request(LWS_PATH, { method: 'PATCH' });
    assertStatus(res, 405);
  });

  it('DELETE returns 405', async () => {
    const res = await request(LWS_PATH, { method: 'DELETE' });
    assertStatus(res, 405);
  });

  it('body scheme matches X-Forwarded-Proto (proxy scheme parity)', async () => {
    // Fastify trustProxy:true honors X-Forwarded-Proto — request.protocol becomes 'https'
    // so the route's proto = request.protocol produces https:// in id and storageDescription.
    const res = await request(LWS_PATH, {
      headers: {
        Accept: 'application/lws+json',
        'X-Forwarded-Proto': 'https',
      }
    });
    assertStatus(res, 200);
    const body = await res.json();
    assert.ok(body.id.startsWith('https://'),
      `id should start with https:// when X-Forwarded-Proto: https, got: ${body.id}`);
    const alice = body.storage.find(s => s.id.endsWith('/alice/'));
    assert.ok(alice, 'alice storage entry must exist');
    assert.ok(alice.storageDescription.startsWith('https://'),
      `alice storageDescription should start with https://, got: ${alice.storageDescription}`);
  });
});

describe('GET /:pod/lws-storage (--lws ON)', () => {
  before(async () => {
    await startTestServer({ lws: true });
    await createTestPod('alice');
  });

  after(async () => {
    await stopTestServer();
  });

  it('returns the per-storage description with id …/alice/, type Storage', async () => {
    const res = await request('/alice/lws-storage', {
      headers: { Accept: 'application/lws+json' }
    });
    assertStatus(res, 200);
    assertHeaderContains(res, 'content-type', 'application/lws+json');
    const body = await res.json();
    assert.ok(body.id.endsWith('/alice/'), `id: ${body.id}`);
    assert.strictEqual(body.type, 'Storage');
    const sd = body.service.find(s => s.type === 'StorageDescription');
    assert.ok(sd, 'service must contain a StorageDescription entry');
    assert.ok(sd.serviceEndpoint.endsWith('/alice/lws-storage'),
      `StorageDescription serviceEndpoint should end with /alice/lws-storage, got: ${sd.serviceEndpoint}`);
  });

  it('server-wide services (TypeIndexService) are origin-level, not pod-scoped', async () => {
    const res = await request('/alice/lws-storage', {
      headers: { Accept: 'application/lws+json' }
    });
    const body = await res.json();
    const ti = body.service.find(s => s.type === 'TypeIndexService');
    assert.ok(ti, 'TypeIndexService must be advertised (default on under --lws)');
    assert.ok(!ti.serviceEndpoint.includes('/alice/'),
      `TypeIndexService should be origin-level, not pod-scoped, got: ${ti.serviceEndpoint}`);
    assert.ok(ti.serviceEndpoint.endsWith('/types/index'),
      `TypeIndexService should end with /types/index, got: ${ti.serviceEndpoint}`);
  });

  it('PUT returns 405', async () => {
    const res = await request('/alice/lws-storage', { method: 'PUT' });
    assertStatus(res, 405);
  });

  it('POST returns 405', async () => {
    const res = await request('/alice/lws-storage', { method: 'POST' });
    assertStatus(res, 405);
  });

  it('PATCH returns 405', async () => {
    const res = await request('/alice/lws-storage', { method: 'PATCH' });
    assertStatus(res, 405);
  });

  it('DELETE returns 405', async () => {
    const res = await request('/alice/lws-storage', { method: 'DELETE' });
    assertStatus(res, 405);
  });

  it('GET /bob/lws-storage (no such pod) returns 404', async () => {
    const res = await request('/bob/lws-storage', {
      headers: { Accept: 'application/lws+json' }
    });
    assertStatus(res, 404);
  });
});

describe('LWS Storage Description Route (--lws OFF)', () => {
  before(async () => {
    // Default — lws not set (off)
    await startTestServer({});
    await createTestPod('alice');
  });

  after(async () => {
    await stopTestServer();
  });

  it('GET /.well-known/lws-storage returns 404 when lws is off', async () => {
    const res = await request(LWS_PATH, {
      headers: { Accept: 'application/lws+json' }
    });
    assertStatus(res, 404);
  });

  // Authenticated as the pod owner — owner Read is the container's default
  // (inherited-to-children) authorization, so this isolates "route not
  // registered" (404) from the orthogonal anonymous-WAC-deny (401) an
  // unauthenticated request to this same nonexistent nested path would hit
  // first when --lws is off and the /:pod/lws-storage bypass (gated on
  // lwsEnabled, by design — it must not blanket-exempt an incidentally
  // named real resource under a non-LWS pod) doesn't apply.
  it('GET /:pod/lws-storage returns 404 when lws is off (route not registered)', async () => {
    const res = await request('/alice/lws-storage', {
      headers: { Accept: 'application/lws+json' },
      auth: 'alice',
    });
    assertStatus(res, 404);
  });
});
