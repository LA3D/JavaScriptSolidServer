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
import net from 'node:net';
import { createServer as createNetServer } from 'net';
import { createServer } from '../src/server.js';
import { stashAsChallenge } from '../src/auth/middleware.js';

const TEST_HOST = 'localhost';

// Raw-socket request with a caller-controlled Host header — fetch() (and
// even node:http's own client) normalize/validate the Host header before
// send, so the only way to reproduce a genuinely malformed one on the wire
// (the shape a misbehaving proxy or a hostile client could still send) is
// to write the request line ourselves.
function rawRequest(port, path, hostHeaderValue) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: TEST_HOST, port }, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostHeaderValue}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk.toString(); });
    socket.on('error', reject);
    socket.on('end', () => resolve(data));
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('rawRequest timed out')); });
  });
}

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

async function createPod(baseUrl, name, visibility) {
  const res = await fetch(`${baseUrl}/.pods`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, email: `${name}@example.com`, password: `${name}-pw-123`,
      ...(visibility ? { visibility } : {}),
    }),
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
  let alice, bob, priv;
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
    priv = await createPod(baseUrl, 'aschalpriv', 'private');
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

  // ---- R18 (item-5 ledger finding, 2026-07-24): the GENERATED-DOCUMENT
  // routes must carry the challenge too. Authorization.html: "A storage
  // server generating a 401 (Unauthorized) response MUST send a
  // WWW-Authenticate header field containing at least one conforming
  // challenge." — "a 401", not "a 401 from the LDP handler". These four
  // routes gate on READ-of-the-storage-root and used to `reply.code(401)
  // .send()` directly, bypassing handleUnauthorized (the choke point that
  // stamps the challenge), so they answered a bare 401 with NO
  // WWW-Authenticate header at all. Same route family round 1 had to
  // hand-patch for ETags (R3/R4): they sit outside the common handler
  // chain, so every cross-cutting response invariant needs re-applying.
  const expectChallenge = (header, storageRoot) => {
    assert.ok(header, 'expected a WWW-Authenticate header on this 401');
    const m = header.match(/Bearer as_uri="([^"]+)", realm="([^"]+)"/);
    assert.ok(m, `expected a conforming Bearer challenge, got: ${header}`);
    assert.equal(m[1], baseUrl);
    assert.equal(m[2], storageRoot);
  };

  it('(h) R18: anon GET /:pod/lws-storage on a private pod -> 401 carries the challenge', async () => {
    const res = await fetch(`${baseUrl}/aschalpriv/lws-storage`, { headers: { Accept: 'application/lws+json' } });
    assert.equal(res.status, 401);
    expectChallenge(res.headers.get('www-authenticate'), priv.uri);
  });

  it('(i) R18: anon GET /:pod/types/index on a private pod -> 401 carries the challenge', async () => {
    const res = await fetch(`${baseUrl}/aschalpriv/types/index`);
    assert.equal(res.status, 401);
    expectChallenge(res.headers.get('www-authenticate'), priv.uri);
  });

  it('(j) R18: anon GET /:pod/types/search on a private pod -> 401 carries the challenge', async () => {
    const res = await fetch(`${baseUrl}/aschalpriv/types/search`);
    assert.equal(res.status, 401);
    expectChallenge(res.headers.get('www-authenticate'), priv.uri);
  });

  it('(k) R18: anon POST /:pod/types/search on a private pod -> 401 carries the challenge', async () => {
    const res = await fetch(`${baseUrl}/aschalpriv/types/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
    expectChallenge(res.headers.get('www-authenticate'), priv.uri);
  });

  it('(l) R18 no-oracle preserved: an UNKNOWN pod name still 404s, with no challenge', async () => {
    // The challenge must not become an existence oracle: /nosuchpod/types/index
    // is a plain 404 (round 2's no-oracle posture) and stays one.
    const res = await fetch(`${baseUrl}/nosuchpod-r18/types/index`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('www-authenticate'), null);
  });

  it('(g) HEAD parity: HEAD on the private resource carries the same challenge as GET', async () => {
    const getRes = await fetch(`${alice.uri}private/`);
    const headRes = await fetch(`${alice.uri}private/`, { method: 'HEAD' });
    assert.equal(headRes.status, 401);
    assert.equal(headRes.headers.get('www-authenticate'), getRes.headers.get('www-authenticate'));
  });

  // ---- review fix (CRITICAL): a malformed Host header must never turn
  // challenge construction into a 500. buildResourceUrl() concatenates
  // request.headers.host into a URL string; a Host containing a space (or
  // any other character illegal in a URL authority) makes `new URL(...)`
  // throw for BOTH the primary (storage-root) attempt AND a naive
  // same-host fallback — the fallback must not just retry the identical
  // failing input. ------------------------------------------------------
  it('malformed Host header never 500s on a private resource (AS on) -- degrades to a safe 401', async () => {
    const raw = await rawRequest(port, '/aschalalice/private/', 'bad host');
    const statusLine = raw.split('\r\n')[0];
    assert.match(statusLine, /^HTTP\/1\.1 401\b/, `expected a clean 401, got: ${statusLine}`);
    assert.doesNotMatch(raw, /HTTP\/1\.1 500/);
  });
});

// ---- review fix (IMPORTANT): "presented and rejected" must not be
// Authorization-header-only. WebID-TLS (client-cert auth) never sets an
// Authorization header at all (src/auth/token.js:303-311 dispatches on
// hasClientCertificate(), not headers.authorization) — a rejected cert was
// falling through to the anonymous (no error param) branch. Exercised as a
// direct unit test of stashAsChallenge() against synthetic request objects,
// per the brief's fallback ("if exercising a real client cert is
// impractical, unit-test the stash function directly with the states it
// receives") — building a real mTLS handshake in this suite would be a
// disproportionate amount of harness for what is fundamentally a pure
// function of (webId, authError, headers, socket).
describe('stashAsChallenge — presented-and-rejected mapping (unit)', () => {
  let server, baseUrl, port;
  const DATA_DIR = './test-data-as-challenge-unit';

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
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  // Minimal synthetic request shape matching what buildResourceUrl /
  // storageRootFor / stashAsChallenge itself read.
  function makeRequest({ authorization, cert = null } = {}) {
    return {
      headers: { host: `${TEST_HOST}:${port}`, authorization },
      protocol: 'http',
      hostname: TEST_HOST,
      url: '/no-such-pod/private/',
      subdomainsEnabled: false,
      baseDomain: null,
      podName: null,
      lwsAsUri: baseUrl,
      raw: { socket: { getPeerCertificate: cert ? () => cert : undefined } },
    };
  }

  it('fully anonymous (no header, no cert, no authError) -> no error param', async () => {
    const req = makeRequest();
    await stashAsChallenge(req, req.url, null, null);
    assert.equal(req._lwsChallenge.error, null);
  });

  it('Authorization header presented and rejected -> error=invalid_token (unchanged baseline case)', async () => {
    const req = makeRequest({ authorization: 'Bearer garbage' });
    await stashAsChallenge(req, req.url, null, 'Invalid token');
    assert.equal(req._lwsChallenge.error, 'invalid_token');
  });

  it('WebID-TLS: a rejected client cert with NO Authorization header still -> error=invalid_token', async () => {
    const req = makeRequest({ cert: { subject: { CN: 'someone' } } });
    // No Authorization header at all -- this is exactly the WebID-TLS shape
    // (src/auth/token.js resolveWebIdFromRequest reaches the cert branch
    // only when authHeader is absent/falsy) -- authError is what
    // resolveWebIdFromRequest actually returns on a failed cert.
    await stashAsChallenge(req, req.url, null, 'WebID-TLS certificate verification failed');
    assert.equal(req._lwsChallenge.error, 'invalid_token');
  });

  it('a cert was offered but webId/authError are both null (defensive) -> still treated as presented', async () => {
    const req = makeRequest({ cert: { subject: { CN: 'someone' } } });
    await stashAsChallenge(req, req.url, null, null);
    assert.equal(req._lwsChallenge.error, 'invalid_token');
  });

  it('successful auth (webId resolved) -> no error param regardless of how it was presented', async () => {
    const req = makeRequest({ authorization: 'Bearer whatever' });
    await stashAsChallenge(req, req.url, 'https://alice.example/#me', null);
    assert.equal(req._lwsChallenge.error, null);
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
