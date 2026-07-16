/**
 * LWS VoID Route Tests (spec §5)
 *
 * Tests GET /.well-known/void when the `void` pointer in the --lws-config
 * pod resource (spec §4b) is configured/unconfigured. P13: the fork only
 * ROUTES to a configured pod resource — it never generates VoID content
 * itself (that document is data, materialized by the lws-pod publish
 * pipeline in a later task). This route is a 303 redirect to whatever pod
 * resource the config's `void` field names.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  startTestServer,
  stopTestServer,
  request,
  createTestPod,
  getBaseUrl,
  assertStatus,
} from './helpers.js';
import * as storage from '../src/storage/filesystem.js';

const VOID_PATH = '/.well-known/void';
const CONFIG_PATH = '/alice/profiles/pod-config.jsonld';

describe('lws: /.well-known/void rung', () => {
  // This describe's --lws-config value is an ABSOLUTE path — the legacy
  // single-podConfig convention (server.js's server-wide `podConfig`, which
  // drives /.well-known/void and is untouched by Task A5). Its VoidService
  // presence is checked separately below, on the per-storage describe —
  // request.podConfigFor (A3), which the per-storage /alice/lws-storage
  // route uses (D5), is DECOUPLED from --lws-config (C2 review fix):
  // podConfigResolver always resolves at the fixed relative convention
  // `profiles/pod-config.jsonld` under each storage root, regardless of
  // what --lws-config names, so this same absolute CONFIG_PATH is safe to
  // reuse there too (see the describe below).
  describe('configured (--lws-config names a void pointer)', () => {
    let base;

    before(async () => {
      await startTestServer({ lws: true, lwsConfig: CONFIG_PATH });
      base = getBaseUrl();
      await createTestPod('alice');
      // Written directly to storage (bypassing HTTP/pod-token plumbing) —
      // makePodConfig reads via storage.stat/read, same as the pod-root
      // skill-discovery helpers (putFile), so no pod/auth setup is needed
      // just to make the resource visible to the server.
      await storage.write(CONFIG_PATH, JSON.stringify({ void: '/alice/profiles/void.jsonld' }));
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

  // Multi-tenant round (Task A5, D5): VoidService moved from the ServerIndex
  // well-known to the per-storage description (/alice/lws-storage), which
  // resolves config via request.podConfigFor (A3) — pinned to the fixed
  // relative convention `profiles/pod-config.jsonld` under the storage root,
  // independent of --lws-config (C2 review fix). Reuses the SAME absolute
  // CONFIG_PATH/lwsConfig fixture as the describe above — proof the two
  // routes' config resolution no longer needs two different fixtures to
  // both work (pre-fix, this describe needed its own relative lwsConfig
  // value or the per-storage lookup would double the pod segment:
  // /alice/alice/profiles/pod-config.jsonld).
  //
  // Pre-merge fix (whole-branch review, Important finding): VoidService is
  // now SUPPRESSED on the per-storage description, even when the per-storage
  // config names a void pointer — the server-wide /.well-known/void route
  // (above) reads the LEGACY server-wide podConfig, not this per-storage
  // config, so advertising it here could misdirect a second tenant to (or
  // 404 against) a DIFFERENT tenant's void. Interim, pending a real
  // per-storage void route (src/lws/storage-description.js).
  describe('configured (per-storage /:pod/lws-storage)', () => {
    let base;

    before(async () => {
      await startTestServer({ lws: true, lwsConfig: CONFIG_PATH });
      base = getBaseUrl();
      await createTestPod('alice');
      await storage.write(CONFIG_PATH, JSON.stringify({ void: '/alice/profiles/void.jsonld' }));
    });

    after(async () => {
      await stopTestServer();
    });

    it('storage description does NOT advertise VoidService (interim suppression, cross-tenant misdirect)', async () => {
      const res = await request('/alice/lws-storage', {
        headers: { Accept: 'application/lws+json' },
      });
      const sd = await res.json();
      assert.equal(sd.service.some((s) => s.type === 'VoidService'), false, 'VoidService must be suppressed on the per-storage description');
    });
  });

  // Same drift-guard as test/mcp-lws-read.test.js's profileIndex case:
  // proves the HTTP route and the MCP ctx (src/mcp/resources.js, via
  // ctx.podConfigFor — Task A7, mirrors request.podConfigFor off the SAME
  // podConfigResolver instance server.js built, A3) agree on the same
  // service set rather than one of them silently drifting from the other.
  //
  // Task A7 (multi-tenant MCP parity — un-skipped/repointed): the HTTP
  // /.well-known/lws-storage route returns a ServerIndex roster, not a
  // Storage document (Task A5, D5) — an intentional shape change. The
  // meaningful "mirrors" comparison now happens at the per-storage
  // /:pod/lws-storage document, which MCP's resources.js readPerStorage-
  // Description now resolves too (previously skip()'d with a documented
  // KNOWN GAP; the gap is closed).
  //
  // Pre-merge fix (whole-branch review, Important finding): VoidService is
  // now suppressed on BOTH the HTTP and MCP per-storage descriptions (both
  // call the SAME buildStorageDescriptionFor) — so the parity this test
  // guards is now parity of ABSENCE, not presence. See the sibling describe
  // above for why (server-wide /.well-known/void route vs. per-storage
  // config mismatch).
  describe('MCP parity (void configured, mcp on)', () => {
    let base;

    before(async () => {
      await startTestServer({ lws: true, mcp: true, lwsConfig: CONFIG_PATH });
      base = getBaseUrl();
      await createTestPod('alice');
      await storage.write(CONFIG_PATH, JSON.stringify({ void: '/alice/profiles/void.jsonld' }));
    });

    after(async () => {
      await stopTestServer();
    });

    it('the per-storage description resource mirrors /alice/lws-storage with void configured (both suppress VoidService)', async () => {
      const httpRes = await fetch(`${base}/alice/lws-storage`);
      const httpBody = await httpRes.json();

      const mcpRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'resources/read',
          params: { uri: `${base}/alice/lws-storage` },
        }),
      });
      const mcpJson = await mcpRes.json();
      const resourceBody = JSON.parse(mcpJson.result.contents[0].text);

      const voidSvc = httpBody.service.find((s) => s.type === 'VoidService');
      assert.equal(voidSvc, undefined, 'HTTP route must NOT advertise VoidService (interim suppression)');
      assert.deepEqual(resourceBody.service, httpBody.service);
    });
  });

  describe('unconfigured (--lws-config not set)', () => {
    let base;

    before(async () => {
      await startTestServer({ lws: true });
      base = getBaseUrl();
      await createTestPod('alice');
    });

    after(async () => {
      await stopTestServer();
    });

    it('GET /.well-known/void → 404', async () => {
      const res = await request(VOID_PATH);
      assertStatus(res, 404);
    });

    // Multi-tenant round (Task A5, D5): checked on the per-storage
    // description, not the ServerIndex well-known.
    it('storage description does not advertise VoidService', async () => {
      const res = await request('/alice/lws-storage', {
        headers: { Accept: 'application/lws+json' },
      });
      const sd = await res.json();
      assert.equal(sd.service.some((s) => s.type === 'VoidService'), false);
    });

    // The write routes are registered unconditionally alongside the GET
    // route (src/server.js), so an unconfigured pod still refuses writes
    // rather than falling through to the generic wildcard write handler —
    // which, under /.well-known/* (WAC-bypassed by the global preHandler),
    // would otherwise accept an unauthenticated write. See dt4-report.md
    // "Fix round 1" for the old-vs-new exposure this closes.
    it('writes → 405 even when unconfigured', async () => {
      const put = await request(VOID_PATH, { method: 'PUT' });
      assertStatus(put, 405);
      const post = await request(VOID_PATH, { method: 'POST' });
      assertStatus(post, 405);
    });
  });
});
