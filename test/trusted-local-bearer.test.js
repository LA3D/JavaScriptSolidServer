/**
 * Trusted-local direct bearer switch (2026-07-24 AS round, task 7 /
 * final-review fix).
 *
 * The design spec (docs/superpowers/specs/2026-07-24-authorization-server-
 * design.md, "Config modes" section + architecture non-negotiables) promises
 * the trusted-local direct bearer (`/idp/credentials`-issued tokens accepted
 * directly at the resource boundary, src/auth/token.js
 * resolveWebIdFromRequest) is config-gated: an explicit named config,
 * default ON, that a public deployment can turn OFF. Task 1 only shipped the
 * capability-report row (`trusted-local direct bearer: ON`, hardcoded) —
 * this file covers the actual switch: `trustedLocalBearer` config (default
 * true), `--trusted-local-bearer` / `--no-trusted-local-bearer` CLI flags,
 * `JSS_TRUSTED_LOCAL_BEARER` env, the request decoration, and enforcement in
 * resolveWebIdFromRequest's two legacy Bearer branches (2-part HMAC token,
 * 3-part IdP-issued JWT).
 *
 * Covers:
 *   (a) default: legacy bearer works (both shapes) — explicit assertion.
 *   (b) switch OFF: a valid legacy IdP bearer is rejected 401 + challenge,
 *       while an at+jwt from the exchange still authenticates.
 *   (c) switch OFF does not affect LWS-CID auth.
 *   (d) capability row reflects OFF.
 *   (e) config parsing: flag + env + precedence.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as jose from 'jose';
import fs from 'fs-extra';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'net';
import { sha256 } from '@noble/hashes/sha2';
import { secp256k1 } from '@noble/curves/secp256k1';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { formatCapabilityReport } from '../src/lws/capability-report.js';
import { createToken, getWebIdFromRequestAsync } from '../src/auth/token.js';
import { provisionOwnerKey } from '../src/keys/provision.js';
import { generateProfile } from '../src/webid/profile.js';
import { _clearProfileCacheForTests } from '../src/auth/lws-cid.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'jss.js');
const TEST_HOST = 'localhost';
const RUN_TIMEOUT_MS = 10_000;

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

function runCli(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  assert.equal(r.signal, null,
    `CLI did not exit within ${RUN_TIMEOUT_MS}ms — args: ${JSON.stringify(args)}; partial stderr: ${r.stderr}`);
  return r;
}

// ---------------------------------------------------------------------
// (e) config parsing: flag + env + precedence
// ---------------------------------------------------------------------
describe('config — trustedLocalBearer parsing', () => {
  const KEY = 'JSS_TRUSTED_LOCAL_BEARER';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('defaults to true (ON) when unset anywhere', async () => {
    const cfg = await loadConfig({}, null);
    assert.equal(cfg.trustedLocalBearer, true);
  });

  it('CLI trustedLocalBearer: false (what --no-trusted-local-bearer normalizes to) turns it off', async () => {
    const cfg = await loadConfig({ trustedLocalBearer: false }, null);
    assert.equal(cfg.trustedLocalBearer, false);
  });

  it('JSS_TRUSTED_LOCAL_BEARER=false is parsed to boolean false (BOOLEAN_KEYS coercion)', async () => {
    process.env[KEY] = 'false';
    const cfg = await loadConfig({}, null);
    assert.equal(cfg.trustedLocalBearer, false);
  });

  it('JSS_TRUSTED_LOCAL_BEARER=true matches --trusted-local-bearer (both true)', async () => {
    process.env[KEY] = 'true';
    const cfgEnv = await loadConfig({}, null);
    const cfgFlag = await loadConfig({ trustedLocalBearer: true }, null);
    assert.equal(cfgEnv.trustedLocalBearer, true);
    assert.equal(cfgEnv.trustedLocalBearer, cfgFlag.trustedLocalBearer);
  });

  it('CLI value takes precedence over env (CLI true beats env false)', async () => {
    process.env[KEY] = 'false';
    const cfg = await loadConfig({ trustedLocalBearer: true }, null);
    assert.equal(cfg.trustedLocalBearer, true);
  });

  it('env value takes precedence over the default (env false beats default true)', async () => {
    process.env[KEY] = 'false';
    const cfg = await loadConfig({}, null);
    assert.equal(cfg.trustedLocalBearer, false);
  });

  it('bin/jss.js start --no-trusted-local-bearer --print-config exits cleanly (0)', () => {
    const r = runCli(['start', '--no-trusted-local-bearer', '--print-config', '--root', './test-data-tlb-cli-off']);
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}; stderr: ${r.stderr}`);
  });

  it('bin/jss.js start --trusted-local-bearer --print-config exits cleanly (0)', () => {
    const r = runCli(['start', '--trusted-local-bearer', '--print-config', '--root', './test-data-tlb-cli-on']);
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}; stderr: ${r.stderr}`);
  });
});

// ---------------------------------------------------------------------
// (d) capability report row reflects the real config
// ---------------------------------------------------------------------
describe('capability report — trusted-local-bearer row', () => {
  const base = { lws: true, lwsTypeIndex: true, lwsProfileConneg: true, lwsConfig: null, mcp: true, lwsAs: false, lwsAsUri: null, lwsAsTtl: 300 };

  it('omitted key still reads ON (back-compat with pre-task-7 fixtures/callers, default-ON semantics)', () => {
    const out = formatCapabilityReport(base, { configResolved: true });
    assert.match(out, /trusted-local direct bearer: ON/);
  });

  it('trustedLocalBearer: true reads ON', () => {
    const out = formatCapabilityReport({ ...base, trustedLocalBearer: true }, { configResolved: true });
    assert.match(out, /trusted-local direct bearer: ON/);
  });

  it('trustedLocalBearer: false reads OFF', () => {
    const out = formatCapabilityReport({ ...base, trustedLocalBearer: false }, { configResolved: true });
    assert.match(out, /trusted-local direct bearer: OFF/);
    assert.doesNotMatch(out, /trusted-local direct bearer: ON/);
  });
});

// ---------------------------------------------------------------------
// (a) default ON — real e2e, both legacy bearer shapes authenticate
// ---------------------------------------------------------------------
describe('e2e — trustedLocalBearer default (ON): legacy bearer still works', () => {
  let server, baseUrl, port;
  let podUri, ownerWebId;
  const DATA_DIR = './test-data-tlb-default-on';

  before(async () => {
    await fs.remove(DATA_DIR);
    await fs.ensureDir(DATA_DIR);
    port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;
    // trustedLocalBearer intentionally omitted — proving the real default,
    // not an explicit `true`.
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
      body: JSON.stringify({ name: 'tlbonpod', email: 'tlbon@example.com', password: 'tlbon-pw-123' }),
    });
    assert.equal(podRes.status, 201, `pod creation should succeed: ${await podRes.text()}`);
    podUri = `${baseUrl}/tlbonpod/`;

    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tlbon@example.com', password: 'tlbon-pw-123' }),
    });
    const credsBody = await credsRes.json();
    assert.equal(credsRes.status, 200, `credentials login should succeed: ${JSON.stringify(credsBody)}`);
    ownerWebId = credsBody.webid;
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  it('a simple 2-part HMAC token authenticates a real GET (default ON)', async () => {
    const token = createToken(ownerWebId);
    const res = await fetch(`${podUri}private/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200, `owner GET with the simple token should succeed by default, got ${res.status}: ${await res.text()}`);
  });

  it('a legacy 3-part IdP-issued JWT bearer authenticates a real GET (default ON)', async () => {
    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tlbon@example.com', password: 'tlbon-pw-123' }),
    });
    const { access_token: idpJwt } = await credsRes.json();
    const res = await fetch(`${podUri}private/`, { headers: { Authorization: `Bearer ${idpJwt}` } });
    assert.equal(res.status, 200, `owner GET with the legacy IdP JWT should succeed by default, got ${res.status}: ${await res.text()}`);
  });
});

// ---------------------------------------------------------------------
// (b) switch OFF — legacy bearer rejected 401 + challenge, exchange path
//     (at+jwt) still authenticates
// ---------------------------------------------------------------------
describe('e2e — trustedLocalBearer: false — legacy bearer rejected, exchange unaffected', () => {
  let server, baseUrl, port;
  let podUri, ownerWebId;
  const DATA_DIR = './test-data-tlb-off';

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
      trustedLocalBearer: false,
      idpIssuer: baseUrl,
      podCreateRateLimitMax: 1000,
      idpRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });

    const podRes = await fetch(`${baseUrl}/.pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'tlboffpod', email: 'tlboff@example.com', password: 'tlboff-pw-123' }),
    });
    assert.equal(podRes.status, 201, `pod creation should succeed: ${await podRes.text()}`);
    podUri = `${baseUrl}/tlboffpod/`;

    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tlboff@example.com', password: 'tlboff-pw-123' }),
    });
    const credsBody = await credsRes.json();
    assert.equal(credsRes.status, 200, `credentials login should succeed: ${JSON.stringify(credsBody)}`);
    ownerWebId = credsBody.webid;
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  it('a simple 2-part HMAC token is rejected 401 with the as_uri/realm challenge', async () => {
    const token = createToken(ownerWebId);
    const res = await fetch(`${podUri}private/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401, `expected 401 with the switch off, got ${res.status}: ${await res.text()}`);
    const header = res.headers.get('www-authenticate');
    assert.match(header, /Bearer as_uri="[^"]+", realm="[^"]+", error="invalid_token"/,
      `expected the upgraded AS challenge with error, got: ${header}`);
  });

  it('a legacy 3-part IdP-issued JWT bearer is rejected 401 with the as_uri/realm challenge', async () => {
    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tlboff@example.com', password: 'tlboff-pw-123' }),
    });
    const { access_token: idpJwt } = await credsRes.json();
    const header0 = jose.decodeProtectedHeader(idpJwt);
    assert.notEqual(header0.typ, 'at+jwt', 'sanity: the legacy IdP JWT must not itself look like an at+jwt');

    const res = await fetch(`${podUri}private/`, { headers: { Authorization: `Bearer ${idpJwt}` } });
    assert.equal(res.status, 401, `expected 401 with the switch off, got ${res.status}: ${await res.text()}`);
    const header = res.headers.get('www-authenticate');
    assert.match(header, /Bearer as_uri="[^"]+", realm="[^"]+", error="invalid_token"/,
      `expected the upgraded AS challenge with error, got: ${header}`);
  });

  it('the same legacy IdP JWT, exchanged via RFC 8693, still authenticates as an at+jwt', async () => {
    const clientId = `${baseUrl}/lws-as/public-client`;
    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tlboff@example.com', password: 'tlboff-pw-123' }),
    });
    const { access_token: idpJwt } = await credsRes.json();

    // The disabled legacy path rejects the bare IdP JWT directly...
    const directRes = await fetch(`${podUri}private/`, { headers: { Authorization: `Bearer ${idpJwt}` } });
    assert.equal(directRes.status, 401);

    // ...but the exchange grant (a completely different code path, driven
    // by verifyIdpJwt called directly from src/idp/token-exchange.js, never
    // through resolveWebIdFromRequest's gated Bearer fallback) still mints
    // a valid at+jwt from that same subject token.
    const exRes = await fetch(`${baseUrl}/idp/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: idpJwt,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        resource: podUri,
        client_id: clientId,
      }).toString(),
    });
    const exBody = await exRes.json();
    assert.equal(exRes.status, 200, `exchange should succeed even with the switch off: ${JSON.stringify(exBody)}`);
    const atJwt = exBody.access_token;

    const res = await fetch(`${podUri}private/`, { headers: { Authorization: `Bearer ${atJwt}` } });
    assert.equal(res.status, 200, `owner GET with the minted at+jwt should succeed despite the switch being off, got ${res.status}: ${await res.text()}`);
  });
});

// ---------------------------------------------------------------------
// (c) switch OFF does not affect LWS-CID auth
// ---------------------------------------------------------------------
describe('trustedLocalBearer: false does not affect LWS-CID auth', () => {
  const POD_ORIGIN = 'https://tlb-cid.example';
  const POD_URI = `${POD_ORIGIN}/`;
  const WEBID = `${POD_URI}profile/card.jsonld#me`;
  const DOC_URL = `${POD_URI}profile/card.jsonld`;
  let realFetch, servedProfile;

  function b64u(bytes) {
    return Buffer.from(bytes).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  function makeEs256kJwt({ secretHex, header, payload }) {
    const h64 = b64u(Buffer.from(JSON.stringify(header)));
    const p64 = b64u(Buffer.from(JSON.stringify(payload)));
    const signingInput = Buffer.from(`${h64}.${p64}`, 'utf8');
    const msgHash = sha256(signingInput);
    const sig = secp256k1.sign(msgHash, hexToBytes(secretHex));
    return `${h64}.${p64}.${b64u(sig.toCompactRawBytes())}`;
  }
  function makeRequest(token, { trustedLocalBearer } = {}) {
    return {
      headers: { authorization: `Bearer ${token}`, host: 'tlb-cid.example' },
      protocol: 'https',
      trustedLocalBearer,
    };
  }

  before(() => {
    realFetch = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u === DOC_URL && servedProfile) {
        return new Response(JSON.stringify(servedProfile), {
          status: 200,
          headers: { 'content-type': 'application/ld+json' },
        });
      }
      return new Response('not found', { status: 404 });
    };
  });

  after(() => {
    global.fetch = realFetch;
  });

  beforeEach(() => {
    servedProfile = null;
    _clearProfileCacheForTests();
  });

  it('a valid LWS-CID JWT authenticates via getWebIdFromRequestAsync with trustedLocalBearer: false', async () => {
    const owner = provisionOwnerKey({ webId: WEBID });
    servedProfile = generateProfile({
      webId: WEBID, name: 'me', podUri: POD_URI, issuer: POD_URI, ownerVm: owner.vm,
    });

    const now = Math.floor(Date.now() / 1000);
    const token = makeEs256kJwt({
      secretHex: owner.secretHex,
      header: { alg: 'ES256K', typ: 'JWT', kid: owner.vm['@id'] },
      payload: { iss: WEBID, sub: WEBID, aud: POD_ORIGIN, client_id: WEBID, iat: now, exp: now + 60 },
    });

    const { webId, error } = await getWebIdFromRequestAsync(makeRequest(token, { trustedLocalBearer: false }));
    assert.equal(error, null, `LWS-CID auth should succeed regardless of trustedLocalBearer; got error: ${error}`);
    assert.equal(webId, WEBID);
  });

  it('the same LWS-CID JWT authenticates identically with trustedLocalBearer: true (no behavior change either way)', async () => {
    const owner = provisionOwnerKey({ webId: WEBID });
    servedProfile = generateProfile({
      webId: WEBID, name: 'me', podUri: POD_URI, issuer: POD_URI, ownerVm: owner.vm,
    });

    const now = Math.floor(Date.now() / 1000);
    const token = makeEs256kJwt({
      secretHex: owner.secretHex,
      header: { alg: 'ES256K', typ: 'JWT', kid: owner.vm['@id'] },
      payload: { iss: WEBID, sub: WEBID, aud: POD_ORIGIN, client_id: WEBID, iat: now, exp: now + 60 },
    });

    const { webId, error } = await getWebIdFromRequestAsync(makeRequest(token, { trustedLocalBearer: true }));
    assert.equal(error, null);
    assert.equal(webId, WEBID);
  });
});
