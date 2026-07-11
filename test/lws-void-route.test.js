/**
 * LWS VoID Route Tests (spec §5)
 *
 * Tests GET /.well-known/void when --lws-void is configured/unconfigured.
 * P13: the fork only ROUTES to a configured pod resource — it never
 * generates VoID content itself (that document is data, materialized by
 * the lws-pod publish pipeline in a later task). This route is a 303
 * redirect to whatever pod resource --lws-void names.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  startTestServer,
  stopTestServer,
  request,
  getBaseUrl,
  assertStatus,
} from './helpers.js';

const VOID_PATH = '/.well-known/void';

describe('lws: /.well-known/void rung', () => {
  describe('configured (--lws-void set)', () => {
    let base;

    before(async () => {
      await startTestServer({ lws: true, lwsVoid: '/alice/profiles/void.jsonld' });
      base = getBaseUrl();
    });

    after(async () => {
      await stopTestServer();
    });

    it('GET /.well-known/void → 303 to the configured pod resource', async () => {
      const res = await request(VOID_PATH, { redirect: 'manual' });
      assertStatus(res, 303);
      assert.equal(res.headers.get('location'), `${base}/alice/profiles/void.jsonld`);
    });

    it('GET /.well-known/void sets Cache-Control public max-age=3600', async () => {
      const res = await request(VOID_PATH, { redirect: 'manual' });
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    });

    it('storage description advertises VoidService with a vocabulary hint', async () => {
      const res = await request('/.well-known/lws-storage', {
        headers: { Accept: 'application/lws+json' },
      });
      const sd = await res.json();
      const v = sd.service.find((s) => s.type === 'VoidService');
      assert.ok(v, 'VoidService entry must be present');
      assert.equal(v.serviceEndpoint, `${base}/.well-known/void`);
      assert.match(v.hint, /vocabular/i);
    });

    it('writes → 405', async () => {
      const put = await request(VOID_PATH, { method: 'PUT' });
      assertStatus(put, 405);
      const post = await request(VOID_PATH, { method: 'POST' });
      assertStatus(post, 405);
      const patch = await request(VOID_PATH, { method: 'PATCH' });
      assertStatus(patch, 405);
      const del = await request(VOID_PATH, { method: 'DELETE' });
      assertStatus(del, 405);
    });
  });

  // Same drift-guard as test/mcp-lws-read.test.js's lwsProfileIndex case:
  // proves the HTTP route and the MCP ctx (src/mcp/index.js, reading
  // request.voidPath) both advertise the same VoidService entry rather
  // than one of them silently omitting it.
  describe('MCP parity (lwsVoid set, mcp on)', () => {
    let base;

    before(async () => {
      await startTestServer({ lws: true, mcp: true, lwsVoid: '/alice/profiles/void.jsonld' });
      base = getBaseUrl();
    });

    after(async () => {
      await stopTestServer();
    });

    it('the storage-description resource mirrors /.well-known/lws-storage with lwsVoid set', async () => {
      const httpRes = await fetch(`${base}/.well-known/lws-storage`);
      const httpBody = await httpRes.json();

      const mcpRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'resources/read',
          params: { uri: `${base}/.well-known/lws-storage` },
        }),
      });
      const mcpJson = await mcpRes.json();
      const resourceBody = JSON.parse(mcpJson.result.contents[0].text);

      const voidSvc = httpBody.service.find((s) => s.type === 'VoidService');
      assert.ok(voidSvc, 'HTTP route must advertise VoidService when lwsVoid is set');
      assert.equal(voidSvc.serviceEndpoint, `${base}/.well-known/void`);
      assert.deepEqual(resourceBody.service, httpBody.service);
    });
  });

  describe('unconfigured (--lws-void not set)', () => {
    let base;

    before(async () => {
      await startTestServer({ lws: true });
      base = getBaseUrl();
    });

    after(async () => {
      await stopTestServer();
    });

    it('GET /.well-known/void → 404', async () => {
      const res = await request(VOID_PATH);
      assertStatus(res, 404);
    });

    it('storage description does not advertise VoidService', async () => {
      const res = await request('/.well-known/lws-storage', {
        headers: { Accept: 'application/lws+json' },
      });
      const sd = await res.json();
      assert.equal(sd.service.some((s) => s.type === 'VoidService'), false);
    });
  });
});
