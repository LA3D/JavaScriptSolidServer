/**
 * LWS Storage Description Route Tests
 *
 * Tests GET /.well-known/lws-storage when --lws is enabled/disabled.
 * Route is additive only — default behavior (lws: false) must not change.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  startTestServer,
  stopTestServer,
  request,
  assertStatus,
  assertHeaderContains
} from './helpers.js';

const LWS_PATH = '/.well-known/lws-storage';

describe('LWS Storage Description Route (--lws ON)', () => {
  before(async () => {
    await startTestServer({ lws: true });
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

  it('body has correct @context, type, and StorageDescription service', async () => {
    const res = await request(LWS_PATH, {
      headers: { Accept: 'application/lws+json' }
    });
    const body = await res.json();
    assert.strictEqual(body['@context'], 'https://www.w3.org/ns/lws/v1', '@context mismatch');
    assert.strictEqual(body.type, 'Storage', 'type mismatch');
    assert.ok(Array.isArray(body.service), 'service must be an array');
    const sd = body.service.find(s => s.type === 'StorageDescription');
    assert.ok(sd, 'service must contain a StorageDescription entry');
    assert.ok(sd.serviceEndpoint.endsWith('/.well-known/lws-storage'),
      `StorageDescription serviceEndpoint should end with /.well-known/lws-storage, got: ${sd.serviceEndpoint}`);
  });

  it('storage id ends with /', async () => {
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
});

describe('LWS Storage Description Route (--lws OFF)', () => {
  before(async () => {
    // Default — lws not set (off)
    await startTestServer({});
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
});
