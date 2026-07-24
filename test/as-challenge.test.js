/**
 * Conforming WWW-Authenticate challenge (2026-07-24 AS round, task 5).
 *
 * When the LWS Authorization Server role is configured (`request.lwsAsUri`
 * set), a 401 on a protected resource must carry a Bearer challenge member
 * shaped `Bearer as_uri="<asUri>", realm="<realm>"[, error="..."]` — the
 * realm being the CANONICAL storage-root URL of the target (the same value
 * a token-exchange for that resource would mint into `aud`). When no AS is
 * configured, the legacy `DPoP realm="Solid", Bearer realm="Solid"` header
 * must stay byte-identical.
 *
 * Boot pattern mirrors test/as-token.test.js: idpIssuer must be known
 * BEFORE listen() (it feeds lwsAsUri), so this file picks its own port
 * directly rather than using test/helpers.js's random-port startTestServer().
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as jose from 'jose';
import fs from 'fs-extra';
import { createServer as createNetServer } from 'net';
import { createServer } from '../src/server.js';

const TEST_HOST = 'localhost';

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

async function createPod(baseUrl, name) {
  const res = await fetch(`${baseUrl}/.pods`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email: `${name}@example.com`, password: `${name}-pw-123` }),
  });
  assert.equal(res.status, 201, `pod creation (${name}) should succeed: ${await res.text()}`);

  const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${name}@example.com`, password: `${name}-pw-123` }),
  });
  const credsBody = await credsRes.json();
  assert.equal(credsRes.status, 200, `credentials login (${name}) should succeed: ${JSON.stringify(credsBody)}`);

  return { name, uri: `${baseUrl}/${name}/`, webId: credsBody.webid, idpJwt: credsBody.access_token };
}

// Exchange an IdP-issued JWT for an at+jwt scoped to `resource` (a storage
// root URI on this deployment).
async function exchangeForAtJwt(baseUrl, idpJwt, resource) {
  const res = await fetch(`${baseUrl}/idp/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idpJwt,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      resource,
      client_id: `${baseUrl}/lws-as/public-client`,
    }).toString(),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `token exchange should succeed: ${JSON.stringify(body)}`);
  return body.access_token;
}

// A well-formed (header-shape-detectable) at+jwt with a bogus signature —
// hasAsToken() commits to this dispatch path on header shape alone, and
// verifyAsToken() then rejects it on signature verification.
async function garbageAtJwt() {
  const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  return new jose.SignJWT({ sub: 'https://nobody.example/#me', aud: 'https://nobody.example/' })
    .setProtectedHeader({ alg: 'RS256', kid: 'garbage-kid', typ: 'at+jwt' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

describe('WWW-Authenticate Bearer as_uri/realm challenge (--lws --lws-as on)', () => {
  let server, baseUrl, port;
  let alice, bob;
  const DATA_DIR = './test-data-as-challenge';

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

    alice = await createPod(baseUrl, 'aschalalice');
    bob = await createPod(baseUrl, 'aschalbob');
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  it('(a) anonymous GET on a private resource -> 401 with Bearer as_uri/realm, no error param', async () => {
    const res = await fetch(`${alice.uri}private/`);
    assert.equal(res.status, 401);
    const header = res.headers.get('www-authenticate');
    assert.ok(header, 'expected a WWW-Authenticate header');
    assert.match(header, /Bearer as_uri="[^"]+", realm="[^"]+"$/);
    const m = header.match(/Bearer as_uri="([^"]+)", realm="([^"]+)"/);
    assert.equal(m[1], baseUrl);
    assert.equal(m[2], alice.uri.replace(/\/$/, '') + '/');
    assert.doesNotMatch(header, /error=/);
  });

  it('(b) garbage at+jwt presented -> 401 with error="invalid_token"', async () => {
    const token = await garbageAtJwt();
    const res = await fetch(`${alice.uri}private/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
    const header = res.headers.get('www-authenticate');
    assert.match(header, /Bearer as_uri="[^"]+", realm="[^"]+", error="invalid_token"/);
  });

  it('(c) alice-audienced valid token on bob\'s resource -> 401, challenge realm = bob\'s root', async () => {
    const atJwt = await exchangeForAtJwt(baseUrl, alice.idpJwt, alice.uri);
    const res = await fetch(`${bob.uri}private/`, { headers: { Authorization: `Bearer ${atJwt}` } });
    assert.equal(res.status, 401);
    const header = res.headers.get('www-authenticate');
    const m = header.match(/Bearer as_uri="([^"]+)", realm="([^"]+)"/);
    assert.ok(m, `expected a Bearer challenge, got: ${header}`);

    // realm must string-equal (origin + pathname normalized) what the
    // exchange would mint as `aud` for bob's storage root.
    const expected = new URL(bob.uri);
    const got = new URL(m[2]);
    assert.equal(got.origin, expected.origin);
    assert.equal(got.pathname, expected.pathname);
    assert.match(header, /error="invalid_token"/);
  });

  it('(d) OPTIONS on the same private resource -> no WWW-Authenticate header at all', async () => {
    const res = await fetch(`${alice.uri}private/`, { method: 'OPTIONS' });
    assert.equal(res.headers.get('www-authenticate'), null);
  });

  it('(e) 404 on a nonexistent path under a public container -> byte-identical (no challenge, status unchanged)', async () => {
    // /public/ (unlike the pod root) carries acl:default public-read, so a
    // missing member here is authorized (public read) and reaches the real
    // 404 handler instead of being denied by WAC first.
    const res = await fetch(`${alice.uri}public/no-such-resource-${Date.now()}`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('www-authenticate'), null);
  });

  it('(g) HEAD parity: HEAD on the private resource carries the same challenge as GET', async () => {
    const getRes = await fetch(`${alice.uri}private/`);
    const headRes = await fetch(`${alice.uri}private/`, { method: 'HEAD' });
    assert.equal(headRes.status, 401);
    assert.equal(headRes.headers.get('www-authenticate'), getRes.headers.get('www-authenticate'));
  });
});

describe('WWW-Authenticate legacy header (--lws on, --lws-as off)', () => {
  let server, baseUrl, port;
  const DATA_DIR = './test-data-as-challenge-off';

  before(async () => {
    await fs.remove(DATA_DIR);
    await fs.ensureDir(DATA_DIR);
    port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;

    server = createServer({
      logger: false,
      root: DATA_DIR,
      lws: true,
      // lwsAs intentionally omitted (off)
      podCreateRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });

    const res = await fetch(`${baseUrl}/.pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'aschaloffpod' }),
    });
    assert.equal(res.status, 201);
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  it('(f) AS not configured -> exact legacy header (snapshot equality)', async () => {
    const res = await fetch(`${baseUrl}/aschaloffpod/private/`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'DPoP realm="Solid", Bearer realm="Solid"');
  });
});
