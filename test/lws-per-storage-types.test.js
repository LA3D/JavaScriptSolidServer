import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, getBaseUrl, createTestPod } from './helpers.js';
import { generateOwnerAcl, serializeAcl } from '../src/wac/parser.js';

const PERSON = 'https://schema.org/Person';
const EVENT = 'https://schema.org/Event';
const LWS_JSON = 'application/lws+json';

describe('per-storage /:pod/types/* (R7/R8/R10)', () => {
  let base, alice, bob;
  before(async () => {
    await startTestServer({ lws: true });
    base = getBaseUrl();
    alice = await createTestPod('alice'); bob = await createTestPod('bob');
    const puts = [ ['alice', alice.token, PERSON], ['bob', bob.token, EVENT] ];
    for (const [pod, token, type] of puts) {
      const r = await fetch(`${base}/${pod}/x1`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Link: `<${type}>; rel="type"` },
        body: JSON.stringify({ n: 1 }) });
      assert.equal(r.status, 201);
    }
    // Pod-root ACLs grant public READ on the container itself only (no
    // acl:default for #public — see generateOwnerAcl), so a freshly PUT
    // child like alice/x1 is owner-only by default. R7's cross-tenant
    // assertion needs alice/x1 genuinely WAC-readable to bob — otherwise
    // "excludes bob even where WAC would allow" has nothing to contrast
    // against. Make it explicit-public, same helper resource.acl tests
    // elsewhere in this suite use.
    const aliceX1Url = `${base}/alice/x1`;
    const aliceX1Acl = await fetch(`${aliceX1Url}.acl`, { method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', Authorization: `Bearer ${alice.token}` },
      body: serializeAcl(generateOwnerAcl(aliceX1Url, alice.webId, false)) });
    assert.ok(aliceX1Acl.status === 200 || aliceX1Acl.status === 201, `alice/x1 acl PUT: ${aliceX1Acl.status}`);
  });
  after(async () => { await stopTestServer(); });

  const items = async (res) => (await res.json()).items.map((i) => i.id);

  it('R7: /alice/types/index excludes bob even where WAC would allow (scope, not authz)', async () => {
    const scoped = await fetch(`${base}/alice/types/index`, { headers: { Authorization: `Bearer ${bob.token}` } });
    assert.equal(scoped.status, 200);
    const scopedTypes = await items(scoped);
    assert.ok(scopedTypes.includes(PERSON), 'alice type present');
    assert.ok(!scopedTypes.includes(EVENT), 'bob type absent despite bob token');
    const origin = await fetch(`${base}/types/index`, { headers: { Authorization: `Bearer ${bob.token}` } });
    assert.ok((await items(origin)).includes(EVENT), 'origin index still cross-storage');
  });

  it('R7: /alice/types/search returns only alice resources', async () => {
    const res = await fetch(`${base}/alice/types/search`, { headers: { Authorization: `Bearer ${bob.token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.totalItems > 0);
    for (const i of body.items) assert.ok(new URL(i.id).pathname.startsWith('/alice/'), i.id);
  });

  it('R8: GET and POST /alice/types/search are equivalent', async () => {
    const get = await fetch(`${base}/alice/types/search?type=${encodeURIComponent(PERSON)}`);
    const post = await fetch(`${base}/alice/types/search`, { method: 'POST',
      headers: { 'Content-Type': LWS_JSON }, body: JSON.stringify({ type: [[PERSON]] }) });
    assert.deepEqual(await get.json(), await post.json());
  });

  it('R10: anon on a private resource — omitted from the per-storage view', async () => {
    // bob/x1 is readable per pod default ACL only if public; make alice/private explicit:
    const put = await fetch(`${base}/alice/secret`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${alice.token}`, Link: `<${EVENT}>; rel="type"` },
      body: JSON.stringify({ s: 1 }) });
    assert.equal(put.status, 201);
    // ACL resources require a JSON-LD payload on PUT (text/turtle 415s —
    // see conneg.test.js "ACL content-type guard (#295)"), so build the
    // owner-only fixture with generateOwnerAcl({ publicRead: false })
    // rather than hand-rolled Turtle.
    const secretUrl = `${base}/alice/secret`;
    const ownerOnlyAcl = generateOwnerAcl(secretUrl, alice.webId, false, { publicRead: false });
    const acl = await fetch(`${base}/alice/secret.acl`, { method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', Authorization: `Bearer ${alice.token}` },
      body: serializeAcl(ownerOnlyAcl) });
    assert.ok(acl.status === 200 || acl.status === 201, `acl PUT: ${acl.status}`);
    const anon = await fetch(`${base}/alice/types/search?type=${encodeURIComponent(EVENT)}`);
    const ids = (await anon.json()).items.map((i) => i.id);
    assert.ok(!ids.some((i) => i.endsWith('/alice/secret')), 'private resource omitted for anon');
    const owner = await fetch(`${base}/alice/types/search?type=${encodeURIComponent(EVENT)}`,
      { headers: { Authorization: `Bearer ${alice.token}` } });
    assert.ok((await owner.json()).items.some((i) => i.id.endsWith('/alice/secret')), 'visible to owner');
  });

  it('no-oracle: unknown pod is a plain 404', async () => {
    const res = await fetch(`${base}/nosuchpod/types/index`);
    assert.equal(res.status, 404);
  });

  it('writes are 405 (reserved names)', async () => {
    for (const [m, path] of [['PUT', 'types/index'], ['POST', 'types/index'], ['DELETE', 'types/search']]) {
      const res = await fetch(`${base}/alice/${path}`, { method: m });
      assert.equal(res.status, 405, `${m} ${path}`);
    }
  });

  it('R3/R4: ETag + If-None-Match 304 on the per-storage GET', async () => {
    const first = await fetch(`${base}/alice/types/index`);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'ETag present');
    const cond = await fetch(`${base}/alice/types/index`, { headers: { 'If-None-Match': etag } });
    assert.equal(cond.status, 304);
  });
});

describe('per-storage /:pod/types/* negative control (no --lws)', () => {
  let alice;
  before(async () => { await startTestServer({ lws: false }); alice = await createTestPod('alice'); });
  after(async () => { await stopTestServer(); });
  it('no route registered: /alice/types/index is an ordinary missing LDP path (404)', async () => {
    // Owner-authenticated (not anon): an anon GET on ANY nonexistent path
    // under a pod 401s here regardless of --lws (WAC-first gate runs before
    // the existence check — see checkAccess), which would conflate "route
    // not registered" with "not authorized". The owner has blanket READ on
    // their own pod, so a 404 here can only mean the resource genuinely
    // doesn't exist — i.e. no special per-storage route intercepted it.
    const res = await fetch(`${getBaseUrl()}/alice/types/index`,
      { headers: { Authorization: `Bearer ${alice.token}` } });
    assert.equal(res.status, 404);
  });
});

describe('per-storage /:pod/types/* root-READ gate on a private storage (C3 parity)', () => {
  // Before the fix, /:pod/types/index and /:pod/types/search never checked
  // the pod root's WAC at all — a private pod's always-public scaffold
  // resources (profile/, etc.) were listable by anyone who knew the pod
  // name. The sibling /:pod/lws-storage route already re-checks READ on the
  // pod root for exactly this reason (C3); these aggregates must match.
  let base, token;
  before(async () => {
    await startTestServer({ lws: true });
    base = getBaseUrl();
    const res = await fetch(`${base}/.pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'priv', visibility: 'private' }),
    });
    assert.equal(res.status, 201);
    ({ token } = await res.json());
  });
  after(async () => { await stopTestServer(); });

  it('anon GET /priv/types/index 401s (pre-fix: 200, scaffold enumerable by pod name)', async () => {
    const res = await fetch(`${base}/priv/types/index`);
    assert.equal(res.status, 401);
  });

  it('anon GET /priv/types/search 401s', async () => {
    const res = await fetch(`${base}/priv/types/search`);
    assert.equal(res.status, 401);
  });

  it('owner GET /priv/types/index 200s', async () => {
    const res = await fetch(`${base}/priv/types/index`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
  });

  it('no-oracle unchanged: anon GET /nosuchpod/types/index is still a plain 404', async () => {
    const res = await fetch(`${base}/nosuchpod/types/index`);
    assert.equal(res.status, 404);
  });
});
