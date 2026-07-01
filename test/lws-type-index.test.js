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

describe('GET/POST /types/search', () => {
  let base, token;
  before(async () => {
    await stopTestServer(); await startTestServer({ lws: true }); base = getBaseUrl();
    token = (await createTestPod('carol')).token;
    const h = (t) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Link: `<${t}>; rel="type"` }, body: '{}' });
    await fetch(`${base}/carol/p1`, h(PERSON));
    await fetch(`${base}/carol/n1`, h('http://ex/Note'));
  });
  after(async () => { await stopTestServer(); });

  it('GET ?type=Person returns only the Person resource', async () => {
    const r = await (await fetch(`${base}/types/search?type=${encodeURIComponent(PERSON)}`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(r.type, 'ContainerPage');
    const ids = r.items.map((i) => i.id);
    assert.ok(ids.some((u) => u.endsWith('/carol/p1')));
    assert.ok(!ids.some((u) => u.endsWith('/carol/n1')));

    const p1 = r.items.find((i) => i.id.endsWith('/carol/p1'));
    assert.deepEqual(p1.type, ['DataResource', PERSON],
      `item type must present the intrinsic class compactly, got ${JSON.stringify(p1.type)}`);
    assert.ok(!p1.type.includes('https://www.w3.org/ns/lws#DataResource'),
      'item type must NOT include the full lws#DataResource URI');
  });
  it('POST body form is equivalent', async () => {
    const r = await (await fetch(`${base}/types/search`, { method: 'POST',
      headers: { 'Content-Type': 'application/lws+json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: [PERSON] }) })).json();
    assert.ok(r.items.map((i) => i.id).some((u) => u.endsWith('/carol/p1')));
  });
  it('POST with wrong media type → 415', async () => {
    const r = await fetch(`${base}/types/search`, { method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` }, body: 'x' });
    assert.equal(r.status, 415);
  });
  it('invalid type URI → 400', async () => {
    const r = await fetch(`${base}/types/search?type=notauri`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 400);
  });
});

describe('storage description advertises the services', () => {
  before(async () => { await stopTestServer(); await startTestServer({ lws: true }); });
  after(async () => { await stopTestServer(); });
  it('lists TypeIndexService + TypeSearchService', async () => {
    const sd = await (await fetch(`${getBaseUrl()}/.well-known/lws-storage`)).json();
    const types = sd.service.map((s) => s.type);
    assert.ok(types.includes('TypeIndexService'));
    assert.ok(types.includes('TypeSearchService'));
  });
});

describe('server-managed type store does not outlive the resource', () => {
  let base, token;
  before(async () => { await stopTestServer(); await startTestServer({ lws: true }); base = getBaseUrl(); token = (await createTestPod('alice')).token; });
  after(async () => { await stopTestServer(); });

  const linkset = async (url) => {
    const r = await fetch(url, { headers: { Accept: 'application/linkset+json', Authorization: `Bearer ${token}` } });
    const body = await r.json();
    return body.linkset[0].type.map((t) => t.href);
  };

  it('DELETE clears the type store: a resource recreated at the same path with no Link declares no phantom types', async () => {
    const url = `${base}/alice/x`;
    const put1 = await fetch(url, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Link: `<${PERSON}>; rel="type"` },
      body: '{}' });
    assert.equal(put1.status, 201);
    assert.ok((await linkset(url)).includes(PERSON));

    const del = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(del.status, 204);

    const put2 = await fetch(url, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}' });
    assert.equal(put2.status, 201);

    const types = await linkset(url);
    assert.ok(!types.includes(PERSON), `phantom schema:Person leaked from the deleted resource, got ${types}`);
    assert.ok(types.includes('https://www.w3.org/ns/lws#DataResource'));
  });

  it('a rewrite with no Link header clears the previously-declared type', async () => {
    const url = `${base}/alice/y`;
    const put1 = await fetch(url, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Link: `<${PERSON}>; rel="type"` },
      body: '{}' });
    assert.equal(put1.status, 201);
    assert.ok((await linkset(url)).includes(PERSON));

    const put2 = await fetch(url, { method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{"changed":true}' });
    assert.equal(put2.status, 204);

    const types = await linkset(url);
    assert.ok(!types.includes(PERSON), `stale schema:Person survived a rewrite with no Link header, got ${types}`);
  });
});

describe('lwsTypeIndex config gate', () => {
  before(async () => { await stopTestServer(); await startTestServer({ lws: true, lwsTypeIndex: false }); });
  after(async () => { await stopTestServer(); });
  it('when disabled, services are not advertised and endpoints are not the type handler', async () => {
    const sd = await (await fetch(`${getBaseUrl()}/.well-known/lws-storage`)).json();
    const types = sd.service.map((s) => s.type);
    assert.ok(!types.includes('TypeIndexService'));
    assert.ok(!types.includes('TypeSearchService'));
    // /types/index is no longer the aggregate handler → not a 200 TypeIndex
    const r = await fetch(`${getBaseUrl()}/types/index`);
    assert.notEqual(r.status, 200);
  });
});
