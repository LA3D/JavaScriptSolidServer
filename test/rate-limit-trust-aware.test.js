/**
 * Trust-aware rate limiting (Task 4c)
 *
 * The resource-endpoint limits (writes PUT/POST/PATCH/DELETE /* and the LWS
 * type-discovery aggregates /types/index + /types/search) are two-tier:
 *   - authenticated caller  → generous per-webId cap (default 600/min,
 *                             tunable via `writeRateLimitMax`) — a runaway-loop
 *                             backstop, not a throttle on legitimate bulk work.
 *   - anonymous caller      → strict per-IP cap (60/min) — crawler/flood defense.
 *
 * These tests prove: an authenticated bearer is NOT throttled at 61 /types/index
 * (was 429 under the old flat 60), an anonymous caller IS capped at 60, and the
 * authenticated write backstop is keyed per-agent (one webId hitting the cap
 * does not throttle a different webId).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { createToken } from '../src/auth/token.js';
import fs from 'fs-extra';
import { createServer as createNetServer } from 'net';

async function getPort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

describe('authenticated /types/index is NOT throttled under the generous cap', () => {
  let server, base, token;
  const DATA_DIR = './test-data-ratelimit-ta-authed';
  before(async () => {
    await fs.remove(DATA_DIR); await fs.ensureDir(DATA_DIR);
    const port = await getPort();
    base = `http://127.0.0.1:${port}`;
    server = createServer({ logger: false, root: DATA_DIR, lws: true, forceCloseConnections: true });
    await server.listen({ port, host: '127.0.0.1' });
    token = createToken('http://example.org/agent-alice#me');
  });
  after(async () => { await server.close(); await fs.remove(DATA_DIR); });

  it('61 authenticated /types/index requests all succeed (under the 600 cap)', async () => {
    let got429 = false, statuses = [];
    for (let i = 0; i < 61; i++) {
      const r = await fetch(`${base}/types/index`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      statuses.push(r.status);
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(!got429, `authenticated caller must not be throttled at 61 (600 cap); saw ${statuses.slice(-3)}`);
  });
});

describe('anonymous /types/index IS capped at the strict per-IP limit', () => {
  let server, base;
  const DATA_DIR = './test-data-ratelimit-ta-anon';
  before(async () => {
    await fs.remove(DATA_DIR); await fs.ensureDir(DATA_DIR);
    const port = await getPort();
    base = `http://127.0.0.1:${port}`;
    server = createServer({ logger: false, root: DATA_DIR, lws: true, forceCloseConnections: true });
    await server.listen({ port, host: '127.0.0.1' });
  });
  after(async () => { await server.close(); await fs.remove(DATA_DIR); });

  it('a 429 appears within 63 anonymous /types/index requests (60/min anon cap)', async () => {
    let got429 = false, count = 0;
    for (let i = 0; i < 63; i++) {
      const r = await fetch(`${base}/types/index`);
      count++;
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, `expected a 429 within 63 anonymous /types/index (anon cap 60), fired ${count}`);
  });
});

describe('authenticated write backstop is keyed per-agent', () => {
  let server, base;
  const DATA_DIR = './test-data-ratelimit-ta-peragent';
  const tokenA = createToken('http://example.org/agent-a#me');
  const tokenB = createToken('http://example.org/agent-b#me');
  before(async () => {
    await fs.remove(DATA_DIR); await fs.ensureDir(DATA_DIR);
    const port = await getPort();
    base = `http://127.0.0.1:${port}`;
    // Low authenticated write cap so the backstop is reachable in a test.
    server = createServer({ logger: false, root: DATA_DIR, lws: true, writeRateLimitMax: 3, forceCloseConnections: true });
    await server.listen({ port, host: '127.0.0.1' });
  });
  after(async () => { await server.close(); await fs.remove(DATA_DIR); });

  it('webId A trips its own 3/min cap, webId B (fresh counter) is unaffected', async () => {
    // The rate-limit onRequest runs before the auth preHandler, so the counter
    // trips regardless of the eventual 401/403 body — we only assert 429 vs not.
    let got429A = false;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${base}/flood/a${i}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${tokenA}`, 'Content-Type': 'text/plain' },
        body: 'x',
      });
      if (r.status === 429) { got429A = true; break; }
    }
    assert.ok(got429A, 'webId A must hit its 3/min authenticated write cap');

    // A DIFFERENT webId has its own counter — its first write must NOT be 429.
    const rB = await fetch(`${base}/flood/b0`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${tokenB}`, 'Content-Type': 'text/plain' },
      body: 'x',
    });
    assert.notEqual(rB.status, 429, 'a different webId must not inherit A\'s tripped counter (per-agent keying)');
  });
});
