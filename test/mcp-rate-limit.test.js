/**
 * MCP rate limiting (Task 4: rate-limit /mcp)
 *
 * POST /mcp previously had no rate limiter at all — an uncapped surface, and
 * the LWS read tools (type-search-over-MCP) make an uncapped full-tree walk
 * possible over that endpoint. This attaches the same trust-aware limiter
 * used by writeRateLimit/typeQueryRateLimit: anonymous → strict per-IP cap,
 * authenticated → generous per-webId cap.
 *
 * Uses the new `anonRateLimitMax` option pass-through (mirrors
 * `writeRateLimitMax`'s existing test-only override) to reach the anon cap
 * in a handful of requests instead of driving 61+.
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

describe('/mcp is rate-limited for anonymous callers', () => {
  let server, base;
  const DATA_DIR = './test-data-ratelimit-mcp';
  before(async () => {
    await fs.remove(DATA_DIR); await fs.ensureDir(DATA_DIR);
    const port = await getPort();
    base = `http://127.0.0.1:${port}`;
    // Low anon cap so the test doesn't have to drive 61+ requests.
    server = createServer({ logger: false, root: DATA_DIR, mcp: true, anonRateLimitMax: 2, forceCloseConnections: true });
    await server.listen({ port, host: '127.0.0.1' });
  });
  after(async () => { await server.close(); await fs.remove(DATA_DIR); });

  it('a 429 appears within 5 anonymous POST /mcp requests (anon cap 2)', async () => {
    let got429 = false, statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }),
      });
      statuses.push(r.status);
      if (r.status === 429) { got429 = true; break; }
    }
    assert.ok(got429, `expected a 429 within 5 anonymous POST /mcp (anon cap 2), saw ${statuses}`);
  });
});
