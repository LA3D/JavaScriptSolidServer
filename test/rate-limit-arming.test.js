/**
 * Rate-limit arming (Task 4b)
 *
 * The route-level rate limits were globally inert: @fastify/rate-limit wires
 * per-route `config.rateLimit` via an onRoute hook added inside the plugin
 * body, which only fires for routes registered AFTER the plugin boots. The
 * idp/ap plugins and the synchronous write/`.pods` routes registered before
 * that hook existed, so their limits never counted and never returned 429.
 *
 * These tests fire each limit past its configured max and assert a real 429.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import fs from 'fs-extra';
import { createServer as createNetServer } from 'net';

async function getPort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

describe('write-flood rate limits fire (429)', () => {
  let server, base;
  const DATA_DIR = './test-data-ratelimit-write';
  before(async () => {
    await fs.remove(DATA_DIR); await fs.ensureDir(DATA_DIR);
    const port = await getPort();
    base = `http://127.0.0.1:${port}`;
    server = createServer({ logger: false, root: DATA_DIR, forceCloseConnections: true });
    await server.listen({ port, host: '127.0.0.1' });
  });
  after(async () => { await server.close(); await fs.remove(DATA_DIR); });

  it('POST /.pods returns 429 after the 1/day limit', async () => {
    // max: 1 per IP per day. First creates a pod; the second must be rate-limited.
    let got429 = false, statuses = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/.pods`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `floodpod${i}` }),
      });
      statuses.push(r.status);
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, `expected a 429 on POST /.pods past max:1, saw statuses ${statuses}`);
  });

  it('PUT /* returns 429 after the 60/min write limit', async () => {
    // writeRateLimit max: 60/min keyed by webId||ip. Unauthenticated writes
    // still pass through the rate-limit onRequest hook (it runs before the
    // auth preHandler), so the counter trips regardless of the 401/403 body.
    let got429 = false;
    for (let i = 0; i < 63; i++) {
      const r = await fetch(`${base}/flood/x${i}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'x',
      });
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, 'expected a 429 within 63 PUTs (writeRateLimit max is 60/min)');
  });
});

describe('idp brute-force rate limits fire (429)', () => {
  let server, base;
  const DATA_DIR = './test-data-ratelimit-idp';
  before(async () => {
    await fs.remove(DATA_DIR); await fs.ensureDir(DATA_DIR);
    const port = await getPort();
    base = `http://127.0.0.1:${port}`;
    server = createServer({ logger: false, root: DATA_DIR, idp: true, idpIssuer: base, forceCloseConnections: true });
    await server.listen({ port, host: '127.0.0.1' });
  });
  after(async () => { await server.close(); await fs.remove(DATA_DIR); });

  it('POST /idp/credentials returns 429 after the 10/min brute-force limit', async () => {
    // max: 10/min keyed by request.ip. The rate-limit hook counts every
    // request (even the 400/401 rejects), so 11+ from one IP must trip.
    let got429 = false, count = 0;
    for (let i = 0; i < 14; i++) {
      const r = await fetch(`${base}/idp/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'brute@example.com', password: `guess${i}` }),
      });
      count++;
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, `expected a 429 within 14 POST /idp/credentials (max 10/min), fired ${count}`);
  });
});
