/**
 * RFC 8693 token-exchange grant (2026-07-24 AS round, task 2).
 *
 * Boots a real server with --lws --idp --lws-as, exercises the actual
 * POST /idp/token endpoint (grant_type=urn:ietf:params:oauth:grant-type:
 * token-exchange) with both subject-token flavors — an LWS-CID JWT and an
 * IdP-issued JWT (headless credentials flow) — plus the error cases from
 * the task brief.
 *
 * The LWS-CID subject token needs a fetchable CID document. Real network
 * SSRF protection (src/utils/ssrf.js) blocks loopback, so — mirroring
 * test/lws-cid.test.js and test/keys-provision-lws-cid.test.js — we stub
 * global.fetch for the one CID-document URL and pass every other request
 * (including this file's own calls into the real running test server)
 * straight through to the real fetch.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as jose from 'jose';
import fs from 'fs-extra';
import { createServer as createNetServer } from 'net';
import { createServer } from '../src/server.js';

const TEST_HOST = 'localhost';
const DATA_DIR = './test-data-token-exchange';
const DATA_DIR_OFF = './test-data-token-exchange-off';

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

// --- LWS-CID subject-token fixture -----------------------------------

const WEBID = 'https://cidsubject.example/profile/card.jsonld#me';
const DOC_URL = 'https://cidsubject.example/profile/card.jsonld';
const VM_ID = `${DOC_URL}#key-1`;

function buildProfile(jwk) {
  return {
    '@context': {
      cid: 'https://www.w3.org/ns/cid/v1#',
      controller: { '@id': 'cid:controller', '@type': '@id' },
      verificationMethod: { '@id': 'cid:verificationMethod', '@container': '@set' },
      authentication: { '@id': 'cid:authentication', '@type': '@id', '@container': '@set' },
      publicKeyJwk: { '@id': 'cid:publicKeyJwk', '@type': '@json' },
    },
    '@id': WEBID,
    controller: WEBID,
    verificationMethod: [{ id: VM_ID, type: 'JsonWebKey', controller: WEBID, publicKeyJwk: jwk }],
    authentication: [VM_ID],
  };
}

async function makeCidSubjectToken({ aud, iat, exp, privateKey }) {
  return new jose.SignJWT({ sub: WEBID, iss: WEBID, client_id: WEBID, aud, iat, exp })
    .setProtectedHeader({ alg: 'ES256', kid: VM_ID, typ: 'JWT' })
    .sign(privateKey);
}

describe('token-exchange grant (RFC 8693)', () => {
  let server, baseUrl, port;
  let cidPrivateKey, cidPublicJwk;
  let realFetch;
  let podUri; // trailing-slash storage root for the created pod, e.g. `${baseUrl}/exchpod/`
  let clientId;

  before(async () => {
    await fs.remove(DATA_DIR);
    await fs.ensureDir(DATA_DIR);

    port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;
    clientId = `${baseUrl}/lws-as/public-client`;

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

    // Storage-root pod. createPodStructure (src/handlers/container.js)
    // marks every new pod lws:Storage unconditionally, so this works even
    // with --idp requiring email/password.
    const podRes = await fetch(`${baseUrl}/.pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'exchpod', email: 'exchpod@example.com', password: 'exchpod-pw-123' }),
    });
    assert.equal(podRes.status, 201, `pod creation should succeed, got ${podRes.status}: ${await podRes.text()}`);
    podUri = `${baseUrl}/exchpod/`;

    // LWS-CID subject-token key material.
    const { publicKey, privateKey } = await jose.generateKeyPair('ES256', { extractable: true });
    cidPrivateKey = privateKey;
    cidPublicJwk = await jose.exportJWK(publicKey);
    cidPublicJwk.alg = 'ES256';

    // Stub global.fetch for exactly the CID document URL; everything else
    // (including this test file's own `fetch()` calls against the real
    // running server) passes through untouched.
    realFetch = global.fetch;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u === DOC_URL) {
        return new Response(JSON.stringify(buildProfile(cidPublicJwk)), {
          status: 200,
          headers: { 'content-type': 'application/ld+json' },
        });
      }
      return realFetch(url, opts);
    };
  });

  after(async () => {
    global.fetch = realFetch;
    await server.close();
    await fs.remove(DATA_DIR);
  });

  function tokenRequest(body) {
    return fetch(`${baseUrl}/idp/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  }

  // ---- (a) valid LWS-CID subject token -----------------------------
  it('(a) exchanges a valid LWS-CID subject token for a resource-scoped at+jwt', async () => {
    const now = Math.floor(Date.now() / 1000);
    const subjectToken = await makeCidSubjectToken({
      aud: baseUrl, iat: now, exp: now + 60, privateKey: cidPrivateKey,
    });

    const res = await tokenRequest({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      resource: podUri,
      client_id: clientId,
    });

    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.ok(body.access_token);
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.expires_in, 300);

    const header = jose.decodeProtectedHeader(body.access_token);
    assert.equal(header.typ, 'at+jwt');

    const payload = jose.decodeJwt(body.access_token);
    assert.equal(payload.sub, WEBID);
    assert.equal(payload.iss, baseUrl);
    assert.equal(payload.aud, podUri);
    assert.equal(payload.client_id, clientId);
    assert.ok(payload.jti);
    assert.ok(payload.iat);
    assert.ok(Math.abs(payload.exp - (payload.iat + 300)) <= 1);
  });

  // ---- (b) valid IdP JWT subject token ------------------------------
  it('(b) exchanges a valid IdP-issued JWT subject token for a resource-scoped at+jwt', async () => {
    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'exchpod@example.com', password: 'exchpod-pw-123' }),
    });
    const credsBody = await credsRes.json();
    assert.equal(credsRes.status, 200, `credentials login should succeed: ${JSON.stringify(credsBody)}`);
    const { access_token: idpJwt, webid: accountWebId } = credsBody;
    assert.ok(idpJwt);

    const res = await tokenRequest({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idpJwt,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      resource: podUri,
      client_id: clientId,
    });

    const body = await res.json();
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.token_type, 'Bearer');
    assert.equal(body.expires_in, 300);

    const header = jose.decodeProtectedHeader(body.access_token);
    assert.equal(header.typ, 'at+jwt');
    const payload = jose.decodeJwt(body.access_token);
    assert.equal(payload.sub, accountWebId);
    assert.equal(payload.iss, baseUrl);
    assert.equal(payload.aud, podUri);
    assert.equal(payload.client_id, clientId);
  });

  // ---- (c) resource does not resolve to a storage root on this deployment
  it('(c) resource that is not a storage root on this deployment -> 400 invalid_target', async () => {
    const res = await tokenRequest({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'irrelevant-because-resource-is-checked-first',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      resource: `${baseUrl}/no-such-pod/`,
      client_id: clientId,
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.error, 'invalid_target');
  });

  // ---- (d) missing/malformed subject_token --------------------------
  it('(d) missing subject_token -> 400 invalid_request', async () => {
    const res = await tokenRequest({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      resource: podUri,
      client_id: clientId,
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.error, 'invalid_request');
  });

  it('(d) malformed (non-JWT) subject_token -> 400 invalid_request', async () => {
    const res = await tokenRequest({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'not-a-jwt-at-all',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      resource: podUri,
      client_id: clientId,
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.error, 'invalid_request');
  });

  // ---- (e) expired CID subject token --------------------------------
  it('(e) expired LWS-CID subject token -> 400 invalid_grant', async () => {
    const now = Math.floor(Date.now() / 1000);
    const subjectToken = await makeCidSubjectToken({
      aud: baseUrl, iat: now - 700, exp: now - 600, privateKey: cidPrivateKey,
    });
    const res = await tokenRequest({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      resource: podUri,
      client_id: clientId,
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.error, 'invalid_grant');
  });

  // ---- (f) subject_token_type mismatch -------------------------------
  it('(f) subject_token_type != the JWT URN -> 400 invalid_request', async () => {
    const res = await tokenRequest({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'irrelevant',
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      resource: podUri,
      client_id: clientId,
    });
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(body.error, 'invalid_request');
  });
});

// ---- (g) grant absent entirely when --lws-as is off ---------------------
describe('token-exchange grant — absent when --lws-as is off', () => {
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
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR_OFF);
  });

  it('rejects the token-exchange grant (no static client, grant not registered)', async () => {
    const res = await fetch(`${baseUrl}/idp/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'irrelevant',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        resource: `${baseUrl}/anything/`,
        client_id: `${baseUrl}/lws-as/public-client`,
      }).toString(),
    });
    assert.notEqual(res.status, 200, 'the grant must not succeed when --lws-as is off');
    const body = await res.json().catch(() => null);
    if (body?.error) {
      assert.ok(
        ['unsupported_grant_type', 'invalid_client'].includes(body.error),
        `expected the grant to be rejected as unsupported or via an unregistered client, got: ${body.error}`
      );
    }
  });
});
