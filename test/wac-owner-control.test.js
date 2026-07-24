// test/wac-owner-control.test.js
// Governance round follow-on (Task 6): implicit owner Control from `.lwsowner`.
//
// Closes two long-standing gaps:
//   1. Owner-lockout — an owner who writes a self-excluding ACL (one that
//      doesn't grant themselves anything) loses even the ability to repair
//      the ACL, because ordinary WAC evaluation denies them like anyone else.
//   2. SEC-1 F3 — the remoteStorage sidecar gate binds `.acl` management to
//      CONTROL on the subject; a bare tree with NO ACL at all fails closed
//      even for the storage's own owner.
//
// The fix (checkAccess, src/wac/checker.js) is deliberately narrow:
//   - fires ONLY on the deny path (grant path untouched, zero extra cost)
//   - grants CONTROL only — never Read/Write/Append — so a self-excluding
//     ACL still excludes the owner from ordinary access; they must repair
//     the ACL and explicitly restore their own access (recovery, not bypass)
//   - reads the storage's `.lwsowner` roster (readOwners); absent sidecar
//     resolves to `[]`, so behavior is byte-identical to the pre-feature tree
//   - must NOT create any new write path to `.lwsowner` itself — that stays
//     refused at the existing System-Managed choke points regardless of
//     Control.
//   - gated on an explicit `lwsEnabled` option (default false, fail-closed):
//     `.lwsowner` is written UNCONDITIONALLY at pod creation (not only under
//     --lws), so every direct call below passes `lwsEnabled: true` — the
//     --lws-off negative control lives in test/as-negative-controls.test.js.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, request } from './helpers.js';
import { checkAccess } from '../src/wac/checker.js';
import { AccessMode, generateOwnerAcl, serializeAcl } from '../src/wac/parser.js';
import { writeOwners, readOwners, captureDeclaredTypes, ownerStorePath, LWS_STORAGE } from '../src/lws/type-metadata.js';
import { clearStorageRootCache } from '../src/lws/storage-resolver.js';
import { createToken } from '../src/auth/token.js';
import * as storage from '../src/storage/filesystem.js';

const OTHER_OWNER = 'https://other-owner.example/#owner2';
const NON_OWNER = 'https://not-an-owner.example/#nobody';

// A self-excluding ACL: grants `grantee` full Read/Write/Control over the
// resource and grants NOBODY else anything — in particular not the pod
// owner, if `grantee` isn't the owner. Models the classic lockout: the owner
// authored (or inherited) an ACL that doesn't include themself at all.
async function writeSelfExcludingAcl(resourceUrl, resourcePath, grantee) {
  const acl = generateOwnerAcl(resourceUrl, grantee, false, { publicRead: false });
  await storage.write(`${resourcePath}.acl`, serializeAcl(acl));
}

describe('implicit owner Control from .lwsowner (unit, checkAccess)', () => {
  test('(a) owner + self-excluding ACL: Control allowed, Read/Write stay denied', async (t) => {
    const pod = await startLwsPod(t, 'ownctla');
    const root = `/${pod.podName}/`;
    await writeOwners(storage, root, [pod.webId]);
    const resourceUrl = `${pod.base}${root}secret`;
    const resourcePath = `${root}secret`;
    await writeSelfExcludingAcl(resourceUrl, resourcePath, OTHER_OWNER);

    const control = await checkAccess({
      resourceUrl, resourcePath, isContainer: false, agentWebId: pod.webId, requiredMode: AccessMode.CONTROL,
      lwsEnabled: true,
    });
    assert.equal(control.allowed, true, 'owner recovers Control via .lwsowner despite the self-excluding ACL');

    const read = await checkAccess({
      resourceUrl, resourcePath, isContainer: false, agentWebId: pod.webId, requiredMode: AccessMode.READ,
      lwsEnabled: true,
    });
    assert.equal(read.allowed, false, 'Read stays denied — this is Control-only recovery, not a bypass');

    const write = await checkAccess({
      resourceUrl, resourcePath, isContainer: false, agentWebId: pod.webId, requiredMode: AccessMode.WRITE,
      lwsEnabled: true,
    });
    assert.equal(write.allowed, false, 'Write stays denied too');
  });

  test('(b) non-owner: Control denied, unchanged', async (t) => {
    const pod = await startLwsPod(t, 'ownctlb');
    const root = `/${pod.podName}/`;
    await writeOwners(storage, root, [pod.webId]);
    const resourceUrl = `${pod.base}${root}secret`;
    const resourcePath = `${root}secret`;
    await writeSelfExcludingAcl(resourceUrl, resourcePath, OTHER_OWNER);

    const control = await checkAccess({
      resourceUrl, resourcePath, isContainer: false, agentWebId: NON_OWNER, requiredMode: AccessMode.CONTROL,
      lwsEnabled: true,
    });
    assert.equal(control.allowed, false, 'an agent absent from .lwsowner gets no implicit Control');
    assert.doesNotMatch(control.wacAllow, /control/, 'WAC-Allow must not advertise control to a non-owner');
  });

  test('(d) WAC-Allow for the owner includes "control" in the user clause', async (t) => {
    const pod = await startLwsPod(t, 'ownctld');
    const root = `/${pod.podName}/`;
    await writeOwners(storage, root, [pod.webId]);
    const resourceUrl = `${pod.base}${root}secret`;
    const resourcePath = `${root}secret`;
    await writeSelfExcludingAcl(resourceUrl, resourcePath, OTHER_OWNER);

    const { wacAllow } = await checkAccess({
      resourceUrl, resourcePath, isContainer: false, agentWebId: pod.webId, requiredMode: AccessMode.CONTROL,
      lwsEnabled: true,
    });
    const userClause = (/user="([^"]*)"/.exec(wacAllow) || [, ''])[1].split(' ').filter(Boolean);
    assert.ok(userClause.includes('control'), `expected "control" in the user clause, got: ${wacAllow}`);
  });

  test('(e) no .lwsowner present -> byte-identical to a guaranteed-non-owner control run', async (t) => {
    const pod = await startLwsPod(t, 'ownctle');
    const root = `/${pod.podName}/`;
    // createPodStructure already stamps a `.lwsowner` at pod creation
    // (governance round) — remove it so this fixture genuinely has no
    // sidecar, modeling a pod that predates that round (the natural --lws
    // gate: readOwners() -> [] when the file is absent).
    await storage.remove(ownerStorePath(root));
    assert.equal(await storage.exists(ownerStorePath(root)), false, 'fixture precondition: no .lwsowner sidecar');
    const resourceUrl = `${pod.base}${root}secret`;
    const resourcePath = `${root}secret`;
    await writeSelfExcludingAcl(resourceUrl, resourcePath, OTHER_OWNER);

    for (const requiredMode of [AccessMode.CONTROL, AccessMode.READ, AccessMode.WRITE]) {
      // lwsEnabled: true on both sides — this negative control is about the
      // ABSENT .lwsowner file being a no-op, not about the --lws flag (that
      // gate is proven separately in test/as-negative-controls.test.js).
      const asPodOwner = await checkAccess({ resourceUrl, resourcePath, isContainer: false, agentWebId: pod.webId, requiredMode, lwsEnabled: true });
      // The control run: an agent who could never be an owner of anything.
      // Absent .lwsowner, the pod owner's result must be indistinguishable
      // from this agent's — proof the feature is a true no-op when the
      // sidecar doesn't exist.
      const asNeverOwner = await checkAccess({ resourceUrl, resourcePath, isContainer: false, agentWebId: NON_OWNER, requiredMode, lwsEnabled: true });
      assert.deepEqual(asPodOwner, asNeverOwner, `mode=${requiredMode}: absent .lwsowner must not distinguish the pod owner`);
    }
  });

  test('(f) multi-owner: the second listed owner also gets Control', async (t) => {
    const pod = await startLwsPod(t, 'ownctlf');
    const root = `/${pod.podName}/`;
    await writeOwners(storage, root, [pod.webId, OTHER_OWNER]);
    const resourceUrl = `${pod.base}${root}secret`;
    const resourcePath = `${root}secret`;
    await writeSelfExcludingAcl(resourceUrl, resourcePath, NON_OWNER);

    const control = await checkAccess({
      resourceUrl, resourcePath, isContainer: false, agentWebId: OTHER_OWNER, requiredMode: AccessMode.CONTROL,
      lwsEnabled: true,
    });
    assert.equal(control.allowed, true, 'the second .lwsowner entry must recover Control too, not just index 0');
  });
});

// SEC-1 F3, end-to-end through the remoteStorage sidecar gate (mirrors the
// fixtures/style of test/remotestorage-sidecar-authz.test.js). remoteStorage
// reaches the SAME `./data` tree at raw root-relative paths (`/storage/me/x`
// -> `/x`), outside any named pod's subtree — so exercising it here means
// marking the ROOT ('/') as the storage and recording its owner, with no
// `.acl` anywhere: the "bare tree" the brief specifies.
describe('SEC-1 F3: remoteStorage sidecar gate on a bare tree (e2e)', () => {
  test('owner manages foo.acl on a bare tree; non-owner still refused', async (t) => {
    const pod = await startLwsPod(t, 'ownctlf3');
    clearStorageRootCache();
    t.after(() => clearStorageRootCache());
    await captureDeclaredTypes(storage, '/', [LWS_STORAGE]);
    await writeOwners(storage, '/', [pod.webId]);
    // No .acl written anywhere — a genuinely bare tree.

    const aclBody = serializeAcl(generateOwnerAcl(`${pod.base}/f3subject`, pod.webId, false, { publicRead: false }));
    const nonOwnerToken = createToken(NON_OWNER, 3600);

    const denied = await request('/storage/me/f3subject.acl', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', Authorization: `Bearer ${nonOwnerToken}` },
      body: aclBody,
    });
    assert.ok([401, 403, 404].includes(denied.status), `non-owner PUT foo.acl must be refused, got ${denied.status}`);
    assert.equal(await storage.exists('/f3subject.acl'), false, 'no .acl may exist after a refused non-owner PUT');

    const put = await request('/storage/me/f3subject.acl', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', Authorization: `Bearer ${pod.token}` },
      body: aclBody,
    });
    assert.ok([200, 201].includes(put.status), `owner PUT foo.acl on a bare tree should now succeed, got ${put.status}`);
    assert.equal(await storage.exists('/f3subject.acl'), true, 'the owner-authored .acl landed');
  });

  test('(g) the owner still cannot write .lwsowner itself, even holding implicit Control', async (t) => {
    const pod = await startLwsPod(t, 'ownctlg');
    clearStorageRootCache();
    t.after(() => clearStorageRootCache());
    await captureDeclaredTypes(storage, '/', [LWS_STORAGE]);
    await writeOwners(storage, '/', [pod.webId]);
    // Bare tree again: any Control the owner holds on '/' is entirely the
    // implicit grant under test (proven by the previous test succeeding for
    // `.acl` under the identical fixture) — yet .lwsowner must stay refused.

    const res = await request('/storage/me/f3subject.lwsowner', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pod.token}` },
      body: JSON.stringify([NON_OWNER]),
    });
    assert.ok([401, 403, 404].includes(res.status), `owner PUT .lwsowner must still be refused, got ${res.status}`);
    assert.equal(await storage.exists('/f3subject.lwsowner'), false, 'no .lwsowner sidecar may be planted');
    assert.deepEqual(await readOwners(storage, '/'), [pod.webId], 'the real .lwsowner record must be unchanged');
  });
});
