import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, getBaseUrl, createTestPod, getPodToken } from './helpers.js';
import { checkAccess } from '../src/wac/checker.js';
import { AccessMode } from '../src/wac/parser.js';

const PERSON = 'https://schema.org/Person';

describe('type capture on write', () => {
  let base, token;
  before(async () => { await startTestServer({ lws: true }); base = getBaseUrl(); const p = await createTestPod('alice'); token = p.token; });
  after(async () => { await stopTestServer(); });

  it('PUT with Link rel=type persists the type (visible in the resource linkset)', async () => {
    const url = `${base}/alice/p1`;
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
                 Link: `<${PERSON}>; rel="type"` },
      body: JSON.stringify({ name: 'Alice' }),
    });
    assert.equal(put.status, 201);
    const ls = await fetch(url, { headers: { Accept: 'application/linkset+json', Authorization: `Bearer ${token}` } });
    const body = await ls.json();
    const types = body.linkset[0].type.map((t) => t.href);
    assert.ok(types.includes(PERSON), `linkset type should include ${PERSON}, got ${types}`);
    assert.ok(types.includes('https://www.w3.org/ns/lws#DataResource'));
  });
});

describe('checkAccess per-query ACL cache', () => {
  let base, token;
  before(async () => {
    await startTestServer({ lws: true });
    base = getBaseUrl();
    const p = await createTestPod('alice');
    token = p.token;
    const put = await fetch(`${base}/alice/p1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Alice' }),
    });
    assert.equal(put.status, 201);
  });
  after(async () => { await stopTestServer(); });

  it('same allow/deny with a shared cache, and the cache gets populated', async () => {
    const cache = new Map();
    const args = { resourceUrl: `${base}/alice/p1`, resourcePath: '/alice/p1',
                   isContainer: false, agentWebId: null, requiredMode: AccessMode.READ };
    const a = await checkAccess({ ...args });               // no cache
    const b = await checkAccess({ ...args, aclCache: cache }); // with cache
    assert.deepEqual(b, a); // cache must not change ANY field of the decision (allowed, wacAllow, isDefault effects, etc.)
    assert.ok(cache.size >= 1, 'cache should hold at least one parsed ACL');
  });
});

describe('GET /types/index', () => {
  let base, token;
  before(async () => {
    await stopTestServer();                       // fresh pod for this block
    await startTestServer({ lws: true }); base = getBaseUrl();
    token = (await createTestPod('bob')).token;
    await fetch(`${base}/bob/person`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Link: `<${PERSON}>; rel="type"` },
      body: '{}' });
  });
  after(async () => { await stopTestServer(); });

  it('bearer caller sees schema:Person; anonymous does not', async () => {
    const authed = await (await fetch(`${base}/types/index`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(authed.type, 'TypeIndex');
    assert.ok(authed.items.some((i) => i.id === PERSON));

    const anon = await (await fetch(`${base}/types/index`)).json();
    assert.ok(!anon.items.some((i) => i.id === PERSON), 'anonymous must not see the private type');
  });
});
