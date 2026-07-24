/**
 * Three-mode negative-control gate (2026-07-24 AS round, task 7, step 1).
 *
 * Consolidates the "must be provably absent when off" claims scattered
 * across test/as-config.test.js, test/as-metadata.test.js,
 * test/as-token.test.js, test/as-challenge.test.js, and
 * test/wac-owner-control.test.js into one file that boots THREE
 * configurations back to back and snapshot-compares the touched surfaces:
 *
 *   (a) OFF-OFF   — no --lws at all (so no --lws-as, no --idp either)
 *   (b) LWS-only  — --lws on, --lws-as off (idp off too, matching the
 *                   existing "legacy header" fixture in as-challenge.test.js)
 *   (c) ON        — --lws --lws-as --idp, the fully-enabled AS role
 *
 * Individual per-task files already assert most of these in isolation;
 * duplication with them is intentional — this file is the single place a
 * reviewer reads to see the whole three-mode boundary at once.
 *
 * FIXED (task 6 follow-up, commit pending): checker.js's
 * `isImplicitOwnerControl` (task 6, commit 5db042a/5db5c6e) used to be
 * documented as "`.lwsowner` only exists under `--lws`", but `.lwsowner` is
 * actually written UNCONDITIONALLY by createPodStructure
 * (src/handlers/container.js, pre-existing governance-round behavior) — so
 * the implicit-owner-Control recovery mechanism was reachable in OFF-OFF
 * mode too, violating this round's global "--lws off is byte-identical"
 * constraint. `checkAccess` now takes an explicit `lwsEnabled` option
 * (default `false`, fail-closed) and every real call site threads
 * `request.lwsEnabled`/`ctx.lwsEnabled` — see the (a) OFF-OFF block below
 * for the direct-call proof that the grant no longer fires without it, and
 * the (b) LWS-only block for the proof it still fires under `--lws` alone.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as jose from 'jose';
import fs from 'fs-extra';
import path from 'node:path';
import { createServer as createNetServer } from 'net';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { formatCapabilityReport } from '../src/lws/capability-report.js';
import { checkAccess } from '../src/wac/checker.js';
import { AccessMode, generateOwnerAcl, serializeAcl } from '../src/wac/parser.js';
import { clearStorageRootCache } from '../src/lws/storage-resolver.js';
import * as storage from '../src/storage/filesystem.js';

const TEST_HOST = 'localhost';
const AS_METADATA_PATH = '/.well-known/lws-configuration';

// Exact legacy WWW-Authenticate value (copied verbatim from
// test/as-challenge.test.js case (f) — must stay byte-identical).
const LEGACY_CHALLENGE = 'DPoP realm="Solid", Bearer realm="Solid"';

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
  const body = await res.json();
  assert.equal(res.status, 201, `pod creation (${name}) should succeed: ${JSON.stringify(body)}`);
  return { name, uri: `${baseUrl}/${name}/`, webId: body.webId || body.webid };
}

// A well-formed-header (typ=at+jwt), garbage-signature bearer token — same
// shape test/as-challenge.test.js's garbageAtJwt() uses.
async function syntheticAtJwt(aud) {
  const { privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  return new jose.SignJWT({ sub: 'https://nobody.example/#me', aud })
    .setProtectedHeader({ alg: 'RS256', kid: 'garbage-kid', typ: 'at+jwt' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

// ---------------------------------------------------------------------
// (a) OFF-OFF: no --lws (so no --lws-as, no --idp either)
// ---------------------------------------------------------------------
describe('AS negative controls — (a) OFF-OFF (no --lws at all)', () => {
  let server, baseUrl, port;
  let pod;
  const DATA_DIR = './test-data-as-negctl-off-off';

  before(async () => {
    await fs.remove(DATA_DIR);
    await fs.ensureDir(DATA_DIR);
    port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;
    server = createServer({
      logger: false,
      root: DATA_DIR,
      // lws / idp / lwsAs all intentionally omitted (off)
      podCreateRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });
    pod = await createPod(baseUrl, 'negctloffoff');
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  it('/.well-known/lws-configuration -> 404, byte-identical to any other unmatched well-known path', async () => {
    const res = await fetch(`${baseUrl}${AS_METADATA_PATH}`);
    const body = await res.text();
    const contentType = res.headers.get('content-type');

    const baselineRes = await fetch(`${baseUrl}/.well-known/totally-unregistered-${Date.now()}`);
    const baselineBody = await baselineRes.text();

    assert.equal(res.status, 404);
    assert.equal(res.status, baselineRes.status);
    assert.equal(contentType, baselineRes.headers.get('content-type'));
    assert.equal(body, baselineBody);
  });

  it('POST /idp/token grant_type=token-exchange -> rejected, no access_token, the grant does not exist', async () => {
    const res = await fetch(`${baseUrl}/idp/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'whatever',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        resource: pod.uri,
        client_id: `${baseUrl}/lws-as/public-client`,
      }).toString(),
    });
    assert.notEqual(res.status, 200, 'the token-exchange grant must not exist without --idp/--lws-as');
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON 404 body is fine */ }
    assert.equal(parsed?.access_token, undefined, 'no access_token must ever be minted');
  });

  it('401 challenge on a private resource -> exact legacy header (snapshot equality)', async () => {
    const res = await fetch(`${pod.uri}private/`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), LEGACY_CHALLENGE);
  });

  it('OPTIONS on the same private resource -> no WWW-Authenticate header (unchanged)', async () => {
    const res = await fetch(`${pod.uri}private/`, { method: 'OPTIONS' });
    assert.equal(res.headers.get('www-authenticate'), null);
  });

  it('a synthetic (typ=at+jwt) bearer token is rejected, not authenticated via any fallback path', async () => {
    const token = await syntheticAtJwt(pod.uri);
    const res = await fetch(`${pod.uri}private/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401, `expected 401, got ${res.status}: ${await res.text()}`);
    // Still the legacy shape -- no as_uri/realm upgrade leaks through.
    assert.equal(res.headers.get('www-authenticate'), LEGACY_CHALLENGE);
  });

  it('capability report carries no lws-as / trusted-local-bearer rows when --lws is off', () => {
    const report = formatCapabilityReport({ lws: false, mcp: false }, {});
    assert.doesNotMatch(report, /lws-as/);
    assert.doesNotMatch(report, /trusted-local direct bearer/);
  });

  // ---- `.lwsowner` is written unconditionally at pod creation (pre-existing
  // governance-round behavior in createPodStructure, unrelated to --lws) —
  // so the negative control that actually matters is behavioral: the
  // implicit-owner-Control recovery mechanism must not fire off this
  // unconditional sidecar when the deployment never turned --lws on. ------
  it('.lwsowner sidecar exists even though --lws is entirely off (pre-existing, unconditional)', async () => {
    const onDisk = await fs.pathExists(path.join(DATA_DIR, pod.name, '.lwsowner'));
    assert.equal(onDisk, true, 'createPodStructure writes .lwsowner unconditionally, not only under --lws');
  });

  it('mode (a): implicit owner Control does NOT fire when --lws is off, even with .lwsowner present', async () => {
    const root = `/${pod.name}/`;
    const OTHER_OWNER = 'https://other-owner.example/#owner2';
    // Self-excluding ACL, same fixture shape as test/wac-owner-control.test.js
    // (a): grants a DIFFERENT agent full RWC, excludes the pod owner entirely.
    const resourceUrl = `${pod.uri}secret`;
    const resourcePath = `${root}secret`;
    const acl = generateOwnerAcl(resourceUrl, OTHER_OWNER, false, { publicRead: false });
    await storage.write(`${resourcePath}.acl`, serializeAcl(acl));

    // No `lwsEnabled` passed — this is the default every real call site in
    // an --lws-off deployment reaches (request.lwsEnabled/ctx.lwsEnabled is
    // false, and every threading site forwards that, never hardcoding true).
    const control = await checkAccess({
      resourceUrl, resourcePath, isContainer: false, agentWebId: pod.webId, requiredMode: AccessMode.CONTROL,
    });
    assert.equal(control.allowed, false,
      'the owner-lockout recovery must stay off when --lws is off, even though .lwsowner exists on disk — ' +
      'off-mode must be byte-identical to a pre-governance-round tree');
  });
});

// ---------------------------------------------------------------------
// (b) LWS-only: --lws on, --lws-as off (idp off too -- matches the
// existing legacy-header fixture in as-challenge.test.js)
// ---------------------------------------------------------------------
describe('AS negative controls — (b) LWS-only (--lws on, --lws-as off)', () => {
  let server, baseUrl, port;
  let pod;
  const DATA_DIR = './test-data-as-negctl-lws-only';

  before(async () => {
    await fs.remove(DATA_DIR);
    await fs.ensureDir(DATA_DIR);
    clearStorageRootCache();
    port = await getAvailablePort();
    baseUrl = `http://${TEST_HOST}:${port}`;
    server = createServer({
      logger: false,
      root: DATA_DIR,
      lws: true,
      // idp / lwsAs intentionally omitted (off)
      podCreateRateLimitMax: 1000,
      forceCloseConnections: true,
    });
    await server.listen({ port, host: TEST_HOST });
    pod = await createPod(baseUrl, 'negctllwsonly');
  });

  after(async () => {
    await server.close();
    clearStorageRootCache();
    await fs.remove(DATA_DIR);
  });

  it('/.well-known/lws-configuration -> 404 (AS surfaces stay off under --lws alone)', async () => {
    const res = await fetch(`${baseUrl}${AS_METADATA_PATH}`);
    assert.equal(res.status, 404);
  });

  it('POST /idp/token grant_type=token-exchange -> rejected, no access_token (no --idp registered)', async () => {
    const res = await fetch(`${baseUrl}/idp/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: 'whatever',
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        resource: pod.uri,
        client_id: `${baseUrl}/lws-as/public-client`,
      }).toString(),
    });
    assert.notEqual(res.status, 200);
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* fine */ }
    assert.equal(parsed?.access_token, undefined);
  });

  it('401 challenge on a private resource -> exact legacy header (snapshot equality)', async () => {
    const res = await fetch(`${pod.uri}private/`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), LEGACY_CHALLENGE);
  });

  it('a synthetic (typ=at+jwt) bearer token is still rejected under --lws alone', async () => {
    const token = await syntheticAtJwt(pod.uri);
    const res = await fetch(`${pod.uri}private/`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401, `expected 401, got ${res.status}: ${await res.text()}`);
  });

  it('capability report: lws-as OFF row + trusted-local-bearer ON row present under --lws alone', () => {
    const report = formatCapabilityReport(
      {
        lws: true, lwsTypeIndex: true, lwsProfileConneg: true, lwsConfig: null, mcp: true,
        lwsAs: false, lwsAsUri: null, lwsAsTtl: 300,
      },
      { configResolved: true },
    );
    assert.match(report, /lws-as\s+OFF/);
    assert.match(report, /trusted-local direct bearer: ON/);
  });

  // ---- governance surfaces UNCHANGED: --lws alone (no --lws-as) must keep
  // the storage-description route and the implicit owner-Control recovery
  // working exactly as before this branch -- both are --lws-gated, not
  // --lws-as-gated. --------------------------------------------------
  it('governance: the storage root still serves its per-storage description', async () => {
    const res = await fetch(`${pod.uri}lws-storage`, { headers: { Accept: 'application/lws+json' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/lws\+json/);
    const body = await res.json();
    assert.equal(body.type, 'Storage');
    assert.ok(body.id.endsWith(`/${pod.name}/`), `id: ${body.id}`);
  });

  it('mode (b): governance: .lwsowner exists and implicit owner Control still fires with --lws on (--lws-gated, not --lws-as-gated)', async () => {
    const root = `/${pod.name}/`;
    assert.equal(await fs.pathExists(path.join(DATA_DIR, pod.name, '.lwsowner')), true);

    // Self-excluding ACL on a subject the owner would ordinarily be denied
    // on (mirrors test/wac-owner-control.test.js's fixture) — proves the
    // .lwsowner-driven recovery genuinely fires under --lws alone.
    const OTHER_OWNER = 'https://other-owner.example/#owner2';
    const resourceUrl = `${pod.uri}secret`;
    const resourcePath = `${root}secret`;
    const acl = generateOwnerAcl(resourceUrl, OTHER_OWNER, false, { publicRead: false });
    await storage.write(`${resourcePath}.acl`, serializeAcl(acl));

    // lwsEnabled: true — this pod is served with --lws on, so the real
    // request path threads request.lwsEnabled === true here; a direct
    // checkAccess() call (no fastify request) must say so explicitly.
    const control = await checkAccess({
      resourceUrl, resourcePath, isContainer: false, agentWebId: pod.webId, requiredMode: AccessMode.CONTROL,
      lwsEnabled: true,
    });
    assert.equal(control.allowed, true, 'owner Control recovery must still work with --lws alone');
  });
});

// ---------------------------------------------------------------------
// (c) ON: --lws --lws-as --idp
// ---------------------------------------------------------------------
describe('AS negative controls — (c) ON (--lws --lws-as --idp)', () => {
  let server, baseUrl, port;
  let alice;
  const DATA_DIR = './test-data-as-negctl-on';

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

    const res = await fetch(`${baseUrl}/.pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'negctlonalice', email: 'negctlonalice@example.com', password: 'negctlon-pw-123' }),
    });
    assert.equal(res.status, 201, `pod creation should succeed: ${await res.text()}`);

    const credsRes = await fetch(`${baseUrl}/idp/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'negctlonalice@example.com', password: 'negctlon-pw-123' }),
    });
    const credsBody = await credsRes.json();
    assert.equal(credsRes.status, 200, `credentials login should succeed: ${JSON.stringify(credsBody)}`);
    alice = { uri: `${baseUrl}/negctlonalice/`, webId: credsBody.webid, idpJwt: credsBody.access_token };
  });

  after(async () => {
    await server.close();
    await fs.remove(DATA_DIR);
  });

  it('/.well-known/lws-configuration -> 200 with the correct issuer', async () => {
    const res = await fetch(`${baseUrl}${AS_METADATA_PATH}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.issuer, baseUrl);
  });

  it('POST /idp/token grant_type=token-exchange -> mints a real access_token', async () => {
    const res = await fetch(`${baseUrl}/idp/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: alice.idpJwt,
        subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
        resource: alice.uri,
        client_id: `${baseUrl}/lws-as/public-client`,
      }).toString(),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `expected the exchange to succeed: ${JSON.stringify(body)}`);
    assert.ok(body.access_token, 'expected a minted access_token');
  });

  it('401 challenge on a private resource carries as_uri/realm', async () => {
    const res = await fetch(`${alice.uri}private/`);
    assert.equal(res.status, 401);
    const header = res.headers.get('www-authenticate');
    assert.match(header, /Bearer as_uri="[^"]+", realm="[^"]+"$/);
    assert.notEqual(header, LEGACY_CHALLENGE);
  });

  it('capability report carries the lws-as ON row', () => {
    const report = formatCapabilityReport(
      {
        lws: true, lwsTypeIndex: true, lwsProfileConneg: true, lwsConfig: null, mcp: true,
        lwsAs: true, lwsAsUri: baseUrl, lwsAsTtl: 300,
      },
      { configResolved: true },
    );
    assert.match(report, /lws-as\s+ON\s+\(as_uri=.*, ttl=300s\)/);
  });
});

// ---------------------------------------------------------------------
// Config invariants (task 1): --lws-as requires --lws and --idp. Already
// covered per-assertion in test/as-config.test.js; repeated here compactly
// as part of the consolidated three-mode gate.
// ---------------------------------------------------------------------
describe('config invariants — --lws-as requires --lws and --idp', () => {
  it('--lws-as without --lws is rejected', async () => {
    await assert.rejects(() => loadConfig({ lwsAs: true }, null), /--lws-as requires --lws/);
  });

  it('--lws-as with --lws but without --idp is rejected', async () => {
    await assert.rejects(() => loadConfig({ lwsAs: true, lws: true }, null), /--lws-as requires --idp/);
  });

  it('--lws-as with --lws and --idp is accepted', async () => {
    const cfg = await loadConfig({ lwsAs: true, lws: true, idp: true }, null);
    assert.equal(cfg.lwsAs, true);
  });
});
