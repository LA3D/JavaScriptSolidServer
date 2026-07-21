/**
 * Sidecar privilege-escalation regression suite (2026-07-21).
 *
 * Three surfaces could write an `.acl` for a SIBLING resource with only container
 * Append/Write: HTTP POST+Slug (upstream b9b38ed), MCP create_resource, MCP write_resource.
 * Each test asserts BOTH that the call is refused AND that no sidecar was created — an
 * error return after a completed write would pass a naive assertion.
 *
 * These tests are RED against the unpatched tree by design: that is the vetting.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx, putFile, request } from './helpers.js';
// Mints an HMAC-signed bearer token for an arbitrary WebID — same pattern as
// test/idp-export.test.js's `intruderToken` — so the HTTP POST case is a
// genuinely *authenticated* foreign agent (holding only container Append via
// appendOnlyAcl below), not an anonymous request that would 401 regardless
// of whether the sidecar guard is correct.
import { createToken } from '../src/auth/token.js';
// storage.exists() checks the filesystem directly, bypassing WAC. Verified
// empirically (2026-07-21) that an HTTP GET probe cannot serve as the
// "sidecar does/doesn't exist" oracle in this codebase: WAC never leaks
// resource existence to a caller without Control — both a nonexistent
// `.acl` and an existing-but-protected `.acl` return 401 (anonymous) or 403
// (authenticated-non-owner) alike, so `probe.status === 404` would fail even
// against a correctly patched server. storage.exists() is the only reliable
// "no sidecar" oracle.
import * as storage from '../src/storage/filesystem.js';
import { applyLwsWrite } from '../src/lws/write.js';

// Fake storage: records writes, reports nothing pre-existing.
function fakeStorage() {
  const writes = [];
  return {
    writes,
    exists: async () => false,
    read: async () => null,
    write: async (p, c) => { writes.push([p, c]); return true; },
    remove: async () => true,
  };
}

const ATTACKER = 'http://attacker.example/profile/card#me';

// An ACL body that grants the attacker Control+Read over the sibling it names.
const selfGrantingAcl = (base, subject) => JSON.stringify({
  '@context': { acl: 'http://www.w3.org/ns/auth/acl#' },
  '@id': '#grab',
  '@type': 'acl:Authorization',
  'acl:agent': { '@id': ATTACKER },
  'acl:accessTo': { '@id': `${base}${subject}` },
  'acl:mode': [{ '@id': 'acl:Control' }, { '@id': 'acl:Read' }],
});

// Container ACL granting the attacker Append only — the minimum privilege for the exploit.
const appendOnlyAcl = (base, container) => JSON.stringify({
  '@context': { acl: 'http://www.w3.org/ns/auth/acl#' },
  '@id': '#append',
  '@type': 'acl:Authorization',
  'acl:agent': { '@id': ATTACKER },
  'acl:accessTo': { '@id': `${base}${container}` },
  'acl:default': { '@id': `${base}${container}` },
  'acl:mode': [{ '@id': 'acl:Append' }, { '@id': 'acl:Write' }],
});

async function seedInbox(pod) {
  const container = `/${pod.podName}/inbox/`;
  await putFile(pod, `${container}seed.txt`, 'seed');
  await putFile(pod, `${container}victim`, 'victim resource');
  await putFile(pod, `${container}.acl`, appendOnlyAcl(pod.base, container));
  return container;
}

const attackerCtx = (pod) => ({
  webId: ATTACKER, origin: pod.base, federationDepth: 0, lwsEnabled: true,
});

describe('sidecar privilege escalation', () => {
  test('MCP create_resource cannot plant a sibling .acl with only container Append', async (t) => {
    const pod = await startLwsPod(t);
    const container = await seedInbox(pod);

    const res = await callTool('create_resource', {
      container,
      slug: 'victim.acl',
      content: selfGrantingAcl(pod.base, `${container}victim`),
      contentType: 'application/ld+json',
    }, attackerCtx(pod));

    assert.equal(res.isError, true, 'create_resource must refuse a sidecar slug');
    const sidecarExists = await storage.exists(`${container}victim.acl`);
    assert.equal(sidecarExists, false, 'no .acl sidecar may exist after a refused create');
  });

  test('MCP write_resource cannot write a sibling .acl with only container Write', async (t) => {
    const pod = await startLwsPod(t);
    const container = await seedInbox(pod);

    const res = await callTool('write_resource', {
      path: `${container}victim.acl`,
      content: selfGrantingAcl(pod.base, `${container}victim`),
      contentType: 'application/ld+json',
    }, attackerCtx(pod));

    assert.equal(res.isError, true, 'write_resource must refuse an .acl without Control');
    const sidecarExists = await storage.exists(`${container}victim.acl`);
    assert.equal(sidecarExists, false, 'no .acl sidecar may exist after a refused write');
  });

  test('HTTP POST with Slug: victim.acl cannot plant a sibling ACL', async (t) => {
    const pod = await startLwsPod(t);
    const container = await seedInbox(pod);

    const attackerToken = createToken(ATTACKER, 3600);
    const res = await request(container, {
      method: 'POST',
      headers: {
        Slug: 'victim.acl',
        'Content-Type': 'application/ld+json',
        Authorization: `Bearer ${attackerToken}`,
      },
      body: selfGrantingAcl(pod.base, `${container}victim`),
    });

    assert.ok(res.status === 401 || res.status === 403,
      `POST Slug: victim.acl must be refused, got ${res.status}`);
    const sidecarExists = await storage.exists(`${container}victim.acl`);
    assert.equal(sidecarExists, false, 'no .acl sidecar may exist after a refused POST');
  });

  // put_typed_resource's describedby branch wrote its target's `.meta` with a direct
  // storage.write, gated only by wac(ctx, metaPath, WRITE) — which falls back to the
  // PARENT CONTAINER for a non-existent `.meta`, so container-Write alone could CREATE
  // a `.meta` for a resource this agent doesn't Control (found in adversarial review of
  // Task 6, not covered by any existing test). Same escalation class as the .acl cases
  // above, on a third MCP surface. The subject (`victim`) already exists and the attacker
  // already holds Write on it via the container's default ACL (seedInbox) — so this test
  // isolates the `.meta`-specific CONTROL-to-create rule from the plain resource-Write
  // check that gates the rest of the tool.
  test('MCP put_typed_resource: container-Write cannot create a sibling .meta, but can update one that already exists', async (t) => {
    const pod = await startLwsPod(t);
    const container = await seedInbox(pod);
    const victimPath = `${container}victim`;
    const metaPath = `${victimPath}.meta`;
    const shapeUrl = `${pod.base}${container}shapes/dummy`;

    // No .meta exists yet for `victim` — attacker holds Write (container default) but not
    // Control, so declaring a describedby (which would CREATE victim.meta) must be refused.
    const createAttempt = await callTool('put_typed_resource', {
      path: victimPath,
      content: 'updated by attacker',
      contentType: 'text/plain',
      describedby: shapeUrl,
    }, attackerCtx(pod));
    assert.equal(createAttempt.isError, true, 'put_typed_resource must refuse creating a .meta without Control');
    assert.equal(await storage.exists(metaPath), false, 'no .meta sidecar may exist after a refused create');
    assert.equal((await storage.read(victimPath)).toString('utf8'), 'victim resource',
      'the primary resource must be untouched by a refused describedby declaration');

    // Now the owner (via direct storage write, bypassing WAC — same pattern as the rest of
    // this suite's seeding) declares a pre-existing .meta for the same resource. The attacker
    // still only holds Write, not Control — but updating an EXISTING .meta only requires Write
    // on the subject (matching the choke point's "Control to create, Write to update" rule),
    // so this call must succeed. This is the check that the fix must not over-tighten.
    await storage.write(metaPath, Buffer.from(JSON.stringify({ '@id': `${pod.base}${victimPath}`, keep: 'ME' }), 'utf8'));
    const updateAttempt = await callTool('put_typed_resource', {
      path: victimPath,
      content: 'updated by attacker',
      contentType: 'text/plain',
      describedby: shapeUrl,
    }, attackerCtx(pod));
    assert.equal(updateAttempt.isError, false, `put_typed_resource must allow updating an existing .meta with only Write: ${JSON.stringify(updateAttempt)}`);
    const meta = JSON.parse((await storage.read(metaPath)).toString('utf8'));
    assert.equal(meta.keep, 'ME', 'prior .meta keys survive the merge');
    assert.equal(meta.describedby, shapeUrl, 'describedby is declared on the allowed update');
  });
});

describe('applyLwsWrite sidecar guard', () => {
  test('refuses an .acl write when the caller lacks Control and never touches storage', async () => {
    const storage = fakeStorage();
    const r = await applyLwsWrite({
      storage,
      storagePath: '/foo/victim.acl',
      resourceUrl: 'http://localhost/foo/victim.acl',
      content: Buffer.from('{}', 'utf8'),
      contentType: 'application/ld+json',
      lwsEnabled: true,
      agentWebId: 'http://localhost/attacker/profile/card#me',
      checkAccessFn: async () => ({ allowed: false }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.problem.status, 403);
    assert.equal(storage.writes.length, 0, 'storage.write must not be reached');
  });

  test('fails closed when no agentWebId is supplied and internal is not set', async () => {
    const storage = fakeStorage();
    const r = await applyLwsWrite({
      storage,
      storagePath: '/foo/victim.acl',
      resourceUrl: 'http://localhost/foo/victim.acl',
      content: Buffer.from('{}', 'utf8'),
      contentType: 'application/ld+json',
      lwsEnabled: true,
      checkAccessFn: async () => ({ allowed: true }),
    });
    assert.equal(r.ok, false);
    assert.equal(storage.writes.length, 0);
  });

  test('allows an .acl write when the caller holds Control', async () => {
    const storage = fakeStorage();
    const r = await applyLwsWrite({
      storage,
      storagePath: '/foo/victim.acl',
      resourceUrl: 'http://localhost/foo/victim.acl',
      content: Buffer.from('{}', 'utf8'),
      contentType: 'application/ld+json',
      lwsEnabled: true,
      agentWebId: 'http://localhost/owner/profile/card#me',
      checkAccessFn: async () => ({ allowed: true }),
    });
    assert.equal(r.ok, true);
    assert.equal(storage.writes.length, 1);
  });

  test('non-sidecar writes are unaffected and need no webid', async () => {
    const storage = fakeStorage();
    const r = await applyLwsWrite({
      storage,
      storagePath: '/foo/note.jsonld',
      resourceUrl: 'http://localhost/foo/note.jsonld',
      content: Buffer.from('{}', 'utf8'),
      contentType: 'application/ld+json',
      lwsEnabled: false,
      checkAccessFn: async () => { throw new Error('must not be called'); },
    });
    assert.equal(r.ok, true);
    assert.equal(storage.writes.length, 1);
  });
});
