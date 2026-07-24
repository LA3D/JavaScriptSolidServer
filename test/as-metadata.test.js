/**
 * RFC 8414 Authorization Server Metadata (2026-07-24 AS round, task 3).
 *
 * GET /.well-known/lws-configuration, anonymous, JSON, present only when
 * --lws-as is on. token_endpoint/jwks_uri must match the running
 * oidc-provider's own /.well-known/openid-configuration values — this file
 * fetches BOTH documents off the same live server and diffs them, rather
 * than hardcoding the provider's paths, so a future provider route change
 * fails this test instead of silently drifting.
 *
 * Boot pattern mirrors test/token-exchange.test.js: idpIssuer must be known
 * BEFORE listen() (it feeds lwsAsUri, the value signed into every minted
 * at+jwt's `iss`), which test/helpers.js's random-port startTestServer()
 * can't guarantee, so this file picks its own port directly.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'net';
import fs from 'fs-extra';
import { createServer } from '../src/server.js';

const TEST_HOST = 'localhost';
const AS_METADATA_PATH = '/.well-known/lws-configuration';

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on('error', reject);
    srv.listen(0, TEST_HOST, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

describe('AS metadata (--lws --lws-as): GET /.well-known/lws-configuration', () => {
  let server, baseUrl;
  const DATA_DIR = './test-data-as-metadata';

  before(async () => {
    await fs.remove(DATA_DIR);
    await fs.ensureDir(DATA_DIR);
    const port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;
    server = createServer({
      logger: false, root: DATA_DIR, lws: true, idp: true, lwsAs: true,
      idpIssuer: baseUrl, podCreateRateLimitMax: 1000, idpRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  it('200 JSON with issuer/token_endpoint/jwks_uri matching the provider\'s own discovery', async () => {
    const res = await fetch(`${baseUrl}${AS_METADATA_PATH}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();

    // issuer is the deployment's own origin (== lwsAsUri, the value
    // token-exchange.js actually signs into `iss` — see src/idp/index.js).
    assert.equal(body.issuer, baseUrl);

    const discoveryRes = await fetch(`${baseUrl}/.well-known/openid-configuration`);
    const discovery = await discoveryRes.json();
    assert.equal(body.token_endpoint, discovery.token_endpoint);
    assert.equal(body.jwks_uri, discovery.jwks_uri);

    assert.deepEqual(body.grant_types_supported, ['urn:ietf:params:oauth:grant-type:token-exchange']);
    assert.deepEqual(body.subject_token_types_supported, ['urn:ietf:params:oauth:token-type:jwt']);
    for (const claim of ['sub', 'iss', 'client_id', 'aud']) {
      assert.ok(body.claims_supported.includes(claim), `claims_supported must include ${claim}`);
    }
  });

  it('writes -> 405', async () => {
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
      const res = await fetch(`${baseUrl}${AS_METADATA_PATH}`, { method });
      assert.equal(res.status, 405, `${method} should be 405`);
    }
  });
});

describe('AS metadata absent when --lws-as is off (--lws only)', () => {
  let server, baseUrl;
  const DATA_DIR = './test-data-as-metadata-lws-only';

  before(async () => {
    await fs.remove(DATA_DIR);
    await fs.ensureDir(DATA_DIR);
    const port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;
    server = createServer({
      logger: false, root: DATA_DIR, lws: true,
      // idp/lwsAs intentionally omitted (off)
      podCreateRateLimitMax: 1000, idpRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  it('404', async () => {
    const res = await fetch(`${baseUrl}${AS_METADATA_PATH}`);
    assert.equal(res.status, 404);
  });
});

describe('AS metadata absent when --lws is off entirely', () => {
  let server, baseUrl, offBody, offStatus, offContentType;
  let baselineServer, baselineBaseUrl, baselineBody, baselineStatus, baselineContentType;
  const DATA_DIR = './test-data-as-metadata-off';
  const DATA_DIR_BASELINE = './test-data-as-metadata-baseline';

  before(async () => {
    await fs.remove(DATA_DIR);
    await fs.ensureDir(DATA_DIR);
    const port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;
    server = createServer({
      logger: false, root: DATA_DIR,
      // lws/idp/lwsAs all intentionally omitted (off)
      podCreateRateLimitMax: 1000, idpRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });
    const res = await fetch(`${baseUrl}${AS_METADATA_PATH}`);
    offStatus = res.status;
    offContentType = res.headers.get('content-type');
    offBody = await res.text();

    // Baseline: an entirely unrelated (definitely-unregistered) path on the
    // SAME no-lws server, to prove the AS-metadata 404 is the plain
    // fall-through 404 rather than some AS-specific 404 handler — "today"
    // means "whatever this deployment already returns for any unmatched
    // path", not a hand-picked expected body.
    await fs.remove(DATA_DIR_BASELINE);
    await fs.ensureDir(DATA_DIR_BASELINE);
    const baselinePort = await getAvailablePort();
    baselineBaseUrl = `http://${TEST_HOST}:${baselinePort}`;
    baselineServer = createServer({
      logger: false, root: DATA_DIR_BASELINE,
      podCreateRateLimitMax: 1000, idpRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await baselineServer.listen({ port: baselinePort, host: TEST_HOST });
    const baselineRes = await fetch(`${baselineBaseUrl}/.well-known/lws-configuration-does-not-exist`);
    baselineStatus = baselineRes.status;
    baselineContentType = baselineRes.headers.get('content-type');
    baselineBody = await baselineRes.text();
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
    await baselineServer.close();
    await fs.remove(DATA_DIR_BASELINE);
  });

  it('404, byte-identical shape to any other unmatched well-known path today', async () => {
    assert.equal(offStatus, 404);
    assert.equal(offStatus, baselineStatus);
    assert.equal(offContentType, baselineContentType);
    assert.equal(offBody, baselineBody);
  });
});
