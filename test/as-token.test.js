/**
 * RS-side at+jwt validation (2026-07-24 AS round, task 4).
 *
 * Covers src/auth/as-token.js (hasAsToken/verifyAsToken) directly — most
 * cases are exercised as unit calls against synthetic request objects,
 * which is the natural granularity for the interface — plus real
 * end-to-end HTTP round trips for: (1) a genuine /idp/token exchange
 * whose resulting at+jwt is then validated through the RS path against a
 * protected resource, (2) the legacy IdP-bearer regression check, (3) the
 * --lws-as-off rejection, and (4) key rotation on a mock external issuer.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as jose from 'jose';
import http from 'node:http';
import fs from 'fs-extra';
import { createServer as createNetServer } from 'net';
import { createServer } from '../src/server.js';
import { getJwks } from '../src/idp/keys.js';
import { hasAsToken, verifyAsToken, _clearAsTokenCachesForTests } from '../src/auth/as-token.js';
import { hasLwsCidAuth } from '../src/auth/lws-cid.js';

const TEST_HOST = 'localhost';
const DATA_DIR = './test-data-as-token';
const DATA_DIR_OFF = './test-data-as-token-off';

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

// The real IdP signing key this deployment mints/verifies self-issued
// at+jwts with — same key + selection (jwks.keys[0], RS256 primary) as
// src/idp/token-exchange.js's currentSigningKey().
async function currentSigningKey() {
  const jwks = await getJwks();
  const jwk = jwks.keys[0];
  const privateKey = await jose.importJWK(jwk, jwk.alg);
  return { privateKey, alg: jwk.alg, kid: jwk.kid };
}

describe('at+jwt RS validation (src/auth/as-token.js)', () => {
  let server, baseUrl, port;
  let aspodUri, otherpodUri, ownerWebId;
  let signingKey;

  before(async () => {
    await fs.remove(DATA_DIR);
    await fs.ensureDir(DATA_DIR);
    port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;

    server = createServer({
      logger: false,
      root: DATA_DIR,
      lws: true,
      idp: true,
      lwsAs: true,
      idpIssuer: baseUrl,
      podCreateRateLimitMax: 1000,
      idpRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });

    const podRes = await fetch(`${baseUrl}/.pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'aspod', email: 'aspod@example.com', password: 'aspod-pw-123' }),
    });
    assert.equal(podRes.status, 201, `pod creation should succeed: ${await podRes.text()}`);
    aspodUri = `${baseUrl}/aspod/`;

    const otherRes = await fetch(`${baseUrl}/.pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'otherpod', email: 'otherpod@example.com', password: 'otherpod-pw-123' }),
    });
    assert.equal(otherRes.status, 201, `pod creation should succeed: ${await otherRes.text()}`);
    otherpodUri = `${baseUrl}/otherpod/`;

    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'aspod@example.com', password: 'aspod-pw-123' }),
    });
    const credsBody = await credsRes.json();
    assert.equal(credsRes.status, 200, `credentials login should succeed: ${JSON.stringify(credsBody)}`);
    ownerWebId = credsBody.webid;
    assert.ok(ownerWebId);

    signingKey = await currentSigningKey();
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  // Build a synthetic Fastify-request-shaped object matching what
  // buildResourceUrl / storageRootFor / verifyAsToken read off it.
  function makeRequest({ token, url = '/aspod/private/', lwsAs = true, lwsAsUri = baseUrl }) {
    return {
      headers: {
        authorization: token !== undefined ? `Bearer ${token}` : undefined,
        host: `${TEST_HOST}:${port}`,
      },
      protocol: 'http',
      hostname: TEST_HOST,
      url,
      subdomainsEnabled: false,
      baseDomain: null,
      podName: null,
      lwsAs,
      lwsAsUri,
    };
  }

  function mint(payload, header, privateKey) {
    return new jose.SignJWT(payload).setProtectedHeader(header).sign(privateKey);
  }

  function validHeader() {
    return { alg: signingKey.alg, kid: signingKey.kid, typ: 'at+jwt' };
  }

  function validPayload(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    return {
      sub: ownerWebId,
      client_id: `${baseUrl}/lws-as/public-client`,
      aud: aspodUri,
      iss: baseUrl,
      iat: now,
      exp: now + 300,
      ...overrides,
    };
  }

  // ---- dispatch-ordering (both directions) --------------------------
  describe('dispatch ordering vs LWS-CID', () => {
    it('an at+jwt (opaque kid, typ=at+jwt) is never mistaken for an LWS-CID token', async () => {
      const token = await mint(validPayload(), validHeader(), signingKey.privateKey);
      const req = makeRequest({ token });
      assert.equal(hasAsToken(req), true, 'hasAsToken should detect it');
      assert.equal(hasLwsCidAuth(req), false, 'hasLwsCidAuth must not also claim it (opaque kid is not a URL)');
    });

    it('an LWS-CID JWT (URL#fragment kid, typ=JWT) is never mistaken for an at+jwt', async () => {
      const { privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
      const token = await mint(
        { sub: 'https://cid.example/card#me', iss: 'https://cid.example/card#me', aud: baseUrl },
        { alg: 'ES256', kid: 'https://cid.example/card#key-1', typ: 'JWT' },
        privateKey,
      );
      const req = makeRequest({ token });
      assert.equal(hasLwsCidAuth(req), true, 'hasLwsCidAuth should detect it');
      assert.equal(hasAsToken(req), false, 'hasAsToken must not also claim it (typ is not at+jwt)');
    });
  });

  // ---- fine-grained validation failures ------------------------------
  describe('verifyAsToken rejections', () => {
    it('bad signature -> rejected', async () => {
      const { privateKey: forgedKey } = await jose.generateKeyPair('RS256', { extractable: true });
      // Real kid (so local JWKSet resolves the REAL public key) but signed
      // with a different private key -> genuine signature mismatch.
      const token = await mint(validPayload(), validHeader(), forgedKey);
      const { webId, error } = await verifyAsToken(makeRequest({ token }));
      assert.equal(webId, null);
      assert.ok(error, 'expected an error');
    });

    it('wrong iss -> rejected', async () => {
      const token = await mint(
        validPayload({ iss: `${baseUrl}-not-us` }),
        validHeader(),
        signingKey.privateKey,
      );
      const { webId, error } = await verifyAsToken(makeRequest({ token }));
      assert.equal(webId, null);
      assert.ok(error);
    });

    it('aud array of 2 -> rejected', async () => {
      const token = await mint(
        validPayload({ aud: [aspodUri, otherpodUri] }),
        validHeader(),
        signingKey.privateKey,
      );
      const { webId, error } = await verifyAsToken(makeRequest({ token }));
      assert.equal(webId, null);
      assert.match(error, /exactly one value/);
    });

    it("aud names a different tenant's storage root -> rejected", async () => {
      const token = await mint(
        validPayload({ aud: otherpodUri }),
        validHeader(),
        signingKey.privateKey,
      );
      const { webId, error } = await verifyAsToken(makeRequest({ token, url: '/aspod/private/' }));
      assert.equal(webId, null);
      assert.match(error, /does not match the target storage root/);
    });

    it('expired -> rejected', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await mint(
        validPayload({ iat: now - 700, exp: now - 600 }),
        validHeader(),
        signingKey.privateKey,
      );
      const { webId, error } = await verifyAsToken(makeRequest({ token }));
      assert.equal(webId, null);
      assert.ok(error);
    });

    it('nbf in the future (beyond skew) -> rejected', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await mint(
        validPayload({ nbf: now + 300 }),
        validHeader(),
        signingKey.privateKey,
      );
      const { webId, error } = await verifyAsToken(makeRequest({ token }));
      assert.equal(webId, null);
      assert.ok(error);
    });

    it('iat in the future beyond 60s skew -> rejected', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await mint(
        validPayload({ iat: now + 120, exp: now + 400 }),
        validHeader(),
        signingKey.privateKey,
      );
      const { webId, error } = await verifyAsToken(makeRequest({ token }));
      assert.equal(webId, null);
      assert.match(error, /iat/);
    });

    it('target resource not under any storage root -> rejected', async () => {
      const token = await mint(validPayload({ aud: aspodUri }), validHeader(), signingKey.privateKey);
      const { webId, error } = await verifyAsToken(makeRequest({ token, url: '/no-such-pod/x' }));
      assert.equal(webId, null);
      assert.match(error, /not under any storage root/);
    });

    it('--lws-as off entirely -> rejected, not passed to legacy bearer path', async () => {
      const token = await mint(validPayload(), validHeader(), signingKey.privateKey);
      const { webId, error } = await verifyAsToken(makeRequest({ token, lwsAs: false, lwsAsUri: null }));
      assert.equal(webId, null);
      assert.match(error, /no trusted issuer/);
    });
  });

  // ---- the valid case -------------------------------------------------
  it('valid at+jwt -> {webId: sub}', async () => {
    const token = await mint(validPayload(), validHeader(), signingKey.privateKey);
    const { webId, error } = await verifyAsToken(makeRequest({ token }));
    assert.equal(error, null);
    assert.equal(webId, ownerWebId);
  });

  // ---- real end-to-end: mint via /idp/token, validate via a real GET --
  it('a real token-exchange-minted at+jwt authenticates a real GET on the RS path', async () => {
    const clientId = `${baseUrl}/lws-as/public-client`;
    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'aspod@example.com', password: 'aspod-pw-123' }),
    });
    const { access_token: idpJwt } = await credsRes.json();

    const exRes = await fetch(`${baseUrl}/idp/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: idpJwt,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        resource: aspodUri,
        client_id: clientId,
      }).toString(),
    });
    const exBody = await exRes.json();
    assert.equal(exRes.status, 200, `exchange should succeed: ${JSON.stringify(exBody)}`);
    const atJwt = exBody.access_token;

    const res = await fetch(`${aspodUri}private/`, { headers: { Authorization: `Bearer ${atJwt}` } });
    assert.equal(res.status, 200, `owner GET with the minted at+jwt should succeed, got ${res.status}: ${await res.text()}`);
  });

  // ---- regression: legacy IdP bearer JWT still authenticates ----------
  it('a legacy IdP-issued bearer JWT still authenticates (no regression from the at+jwt dispatch)', async () => {
    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'aspod@example.com', password: 'aspod-pw-123' }),
    });
    const { access_token: idpJwt } = await credsRes.json();
    const header = jose.decodeProtectedHeader(idpJwt);
    assert.notEqual(header.typ, 'at+jwt', 'sanity: the legacy IdP JWT must not itself look like an at+jwt');

    const res = await fetch(`${aspodUri}private/`, { headers: { Authorization: `Bearer ${idpJwt}` } });
    assert.equal(res.status, 200, `owner GET with the legacy IdP JWT should still succeed, got ${res.status}`);
  });

  // ---- rotation: mock external issuer, memoized-per-issuer + jose's own
  // refetch-on-unknown-kid caching -----------------------------------
  describe('key rotation on a remote (mock) issuer', () => {
    let mockServer, mockBaseUrl, currentJwks;

    before(async () => {
      currentJwks = { keys: [] };
      mockServer = http.createServer((req, res) => {
        if (req.url === '/.well-known/lws-configuration') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            issuer: mockBaseUrl,
            token_endpoint: `${mockBaseUrl}/token`,
            jwks_uri: `${mockBaseUrl}/jwks-endpoint`,
            grant_types_supported: ['urn:ietf:params:oauth:grant-type:token-exchange'],
            subject_token_types_supported: ['urn:ietf:params:oauth:token-type:jwt'],
          }));
        } else if (req.url === '/jwks-endpoint') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(currentJwks));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      const mockPort = await new Promise((resolve) => {
        mockServer.listen(0, '127.0.0.1', () => resolve(mockServer.address().port));
      });
      mockBaseUrl = `http://127.0.0.1:${mockPort}`;
    });

    after(async () => {
      await new Promise((resolve) => mockServer.close(resolve));
    });

    it('verifies against the mock issuer, then rejects the old key and accepts the new one after rotation', async () => {
      _clearAsTokenCachesForTests();

      const { publicKey: pubA, privateKey: privA } = await jose.generateKeyPair('ES256', { extractable: true });
      const jwkA = await jose.exportJWK(pubA);
      jwkA.kid = 'key-a';
      jwkA.alg = 'ES256';
      currentJwks = { keys: [jwkA] };

      const now = Math.floor(Date.now() / 1000);
      const tokenA = await mint(
        { sub: ownerWebId, aud: aspodUri, iss: mockBaseUrl, iat: now, exp: now + 300 },
        { alg: 'ES256', kid: 'key-a', typ: 'at+jwt' },
        privA,
      );

      const reqA = makeRequest({ token: tokenA, lwsAsUri: mockBaseUrl });
      const first = await verifyAsToken(reqA);
      assert.equal(first.error, null, `expected key-a token to verify: ${first.error}`);
      assert.equal(first.webId, ownerWebId);

      // Rotate: the mock issuer now serves ONLY the new key. Force our
      // per-issuer cache to drop the old RemoteJWKSet instance — without
      // this, jose's own 30s refetch cooldown (just primed by the fetch
      // above) would make this test either flaky or slow; a fresh
      // instance's first lookup always fetches unconditionally.
      const { publicKey: pubB, privateKey: privB } = await jose.generateKeyPair('ES256', { extractable: true });
      const jwkB = await jose.exportJWK(pubB);
      jwkB.kid = 'key-b';
      jwkB.alg = 'ES256';
      currentJwks = { keys: [jwkB] };
      _clearAsTokenCachesForTests();

      const tokenB = await mint(
        { sub: ownerWebId, aud: aspodUri, iss: mockBaseUrl, iat: now, exp: now + 300 },
        { alg: 'ES256', kid: 'key-b', typ: 'at+jwt' },
        privB,
      );
      const reqB = makeRequest({ token: tokenB, lwsAsUri: mockBaseUrl });
      const rotated = await verifyAsToken(reqB);
      assert.equal(rotated.error, null, `expected key-b token to verify after rotation: ${rotated.error}`);
      assert.equal(rotated.webId, ownerWebId);

      // The old key-a token, presented again now that the issuer has
      // rotated away from it, must fail — key-a is no longer resolvable
      // from the (now cached-on-key-b) remote JWKS.
      const oldAgain = await verifyAsToken(reqA);
      assert.equal(oldAgain.webId, null);
      assert.ok(oldAgain.error, 'old key must be rejected post-rotation');
    });
  });
});

// ---- --lws-as off entirely: a presented at+jwt is rejected, never
// silently authenticated via the legacy Bearer path -----------------------
describe('at+jwt presented when --lws-as is off (real HTTP round trip)', () => {
  let server, baseUrl, port;

  before(async () => {
    await fs.remove(DATA_DIR_OFF);
    await fs.ensureDir(DATA_DIR_OFF);
    port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;
    server = createServer({
      logger: false,
      root: DATA_DIR_OFF,
      lws: true,
      idp: true,
      // lwsAs intentionally omitted (off)
      idpIssuer: baseUrl,
      podCreateRateLimitMax: 1000,
      idpRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });

    const podRes = await fetch(`${baseUrl}/.pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'offpod', email: 'offpod@example.com', password: 'offpod-pw-123' }),
    });
    assert.equal(podRes.status, 201);
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR_OFF);
  });

  it('an at+jwt-shaped Bearer token is rejected (401), not routed to the legacy Bearer path', async () => {
    const { privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
    const token = await new jose.SignJWT({ sub: 'https://nobody.example/#me', aud: `${baseUrl}/offpod/` })
      .setProtectedHeader({ alg: 'ES256', kid: 'whatever', typ: 'at+jwt' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    const res = await fetch(`${baseUrl}/offpod/private/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401, `expected 401, got ${res.status}: ${await res.text()}`);
  });
});
