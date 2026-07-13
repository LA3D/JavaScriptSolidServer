// test/lws-etag-variant.test.js
// Task 10 (probe-#6 F2): one strong ETag (`stats.etag`, md5(mtime+size))
// covered EVERY representation of a resource — a format-switching client
// could 304-revalidate a wrong-format cache entry, and a WAC-filtered
// listing varied by requester under one shared ETag. Representations that
// DIFFER from the stored bytes now carry a variant-keyed strong ETag
// (`"<hash>-<key>"`); own-format reads (bytes-are-bytes, Task 1's
// short-circuit) keep the bare `stats.etag`. All --lws-gated.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';
import * as storage from '../src/storage/filesystem.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const BARE_ETAG_RE = /^"[0-9a-f]{32}"$/;

function docBody(base, path) {
  return JSON.stringify({
    '@context': { name: 'https://schema.org/name' },
    '@graph': [{ '@id': `${base}${path}#a`, name: 'A' }],
  });
}

describe('lws: representation-keyed file ETags (probe-#6 F2)', () => {
  let base;
  const DOC = '/etagv/public/r.jsonld';

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    await createTestPod('etagv');
    await request(DOC, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'etagv',
      body: docBody(base, DOC) });
  });
  after(stopTestServer);

  it('own-format GET (JSON-LD, the stored format) keeps the bare stats ETag', async () => {
    const r = await request(DOC, { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    const etag = r.headers.get('etag');
    assert.match(etag, BARE_ETAG_RE, `expected a bare md5 ETag, got ${etag}`);
  });

  it('Turtle and JSON-LD variants of one resource carry different ETags', async () => {
    const jsonld = await request(DOC, { headers: { Accept: 'application/ld+json' } });
    const ttl = await request(DOC, { headers: { Accept: 'text/turtle' } });
    assertStatus(ttl, 200);
    const jsonldEtag = jsonld.headers.get('etag');
    const ttlEtag = ttl.headers.get('etag');
    assert.notEqual(ttlEtag, jsonldEtag);
    assert.match(ttlEtag, /-ttl"$/, `expected a -ttl variant suffix, got ${ttlEtag}`);
  });

  it('N-Quads gets its own variant key, distinct from Turtle', async () => {
    const nq = await request(DOC, { headers: { Accept: 'application/n-quads' } });
    assertStatus(nq, 200);
    assert.match(nq.headers.get('etag'), /-nq"$/);
  });

  it('If-None-Match with the Turtle-variant ETag on a JSON-LD request → 200, not 304', async () => {
    const ttl = await request(DOC, { headers: { Accept: 'text/turtle' } });
    const ttlEtag = ttl.headers.get('etag');
    const r = await request(DOC, { headers: { Accept: 'application/ld+json', 'If-None-Match': ttlEtag } });
    assert.equal(r.status, 200, 'a JSON-LD request must not 304 off the Turtle variant\'s ETag');
  });

  it('If-None-Match with the bare (JSON-LD) ETag on a Turtle request → 200, not 304 (the reverse direction)', async () => {
    const jsonld = await request(DOC, { headers: { Accept: 'application/ld+json' } });
    const bareEtag = jsonld.headers.get('etag');
    const r = await request(DOC, { headers: { Accept: 'text/turtle', 'If-None-Match': bareEtag } });
    assert.equal(r.status, 200, 'a Turtle request must not 304 off the bare/JSON-LD ETag — this is the probe-#6 F2 signature');
  });

  it('If-None-Match with the MATCHING variant ETag still 304s (revalidation keeps working)', async () => {
    const ttl = await request(DOC, { headers: { Accept: 'text/turtle' } });
    const ttlEtag = ttl.headers.get('etag');
    const r = await request(DOC, { headers: { Accept: 'text/turtle', 'If-None-Match': ttlEtag } });
    assert.equal(r.status, 304);
  });

  it('HEAD and GET emit byte-identical ETags for the same variant', async () => {
    const g = await request(DOC, { headers: { Accept: 'text/turtle' } });
    const h = await request(DOC, { method: 'HEAD', headers: { Accept: 'text/turtle' } });
    assertStatus(h, 200);
    assert.equal(h.headers.get('etag'), g.headers.get('etag'));
  });

  it('linkset representation for a file carries the -ls variant key', async () => {
    const r = await request(DOC, { headers: { Accept: 'application/linkset+json' } });
    assertStatus(r, 200);
    assert.match(r.headers.get('etag'), /-ls"$/);
  });
});

describe('lws: representation- and visibility-keyed container listing ETags (probe-#6 F2)', () => {
  let base, owner;
  const OPEN = '/etagvis/public/open.jsonld';
  const PRIV = '/etagvis/public/priv.jsonld';
  const CONTAINER = '/etagvis/public/';

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    owner = await createTestPod('etagvis');
    await request(OPEN, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'etagvis',
      body: docBody(base, OPEN) });
    await request(PRIV, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'etagvis',
      body: docBody(base, PRIV) });
    const aclRes = await request(`${PRIV}.acl`, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'etagvis',
      body: serializeAcl(generatePrivateAcl(`${base}${PRIV}`, owner.webId, false)) });
    assert.ok([200, 201, 204].includes(aclRes.status));
  });
  after(stopTestServer);

  it('listing ETag changes when the visible member set changes (anon vs owner)', async () => {
    const anon = await request(CONTAINER, { headers: { Accept: 'application/ld+json' } });
    const asOwner = await request(CONTAINER, { headers: { Accept: 'application/ld+json' }, auth: 'etagvis' });
    assertStatus(anon, 200);
    assertStatus(asOwner, 200);
    assert.notEqual(anon.headers.get('etag'), asOwner.headers.get('etag'));
  });

  it('lws+json listing carries the -lws variant key and differs from the ld+json listing', async () => {
    const ldjson = await request(CONTAINER, { headers: { Accept: 'application/ld+json' }, auth: 'etagvis' });
    const lws = await request(CONTAINER, { headers: { Accept: 'application/lws+json' }, auth: 'etagvis' });
    assertStatus(lws, 200);
    assert.match(lws.headers.get('etag'), /-lws-[0-9a-f]{8}"$/);
    assert.notEqual(lws.headers.get('etag'), ldjson.headers.get('etag'));
  });

  it('linkset listing carries the -ls variant key', async () => {
    const r = await request(CONTAINER, { headers: { Accept: 'application/linkset+json' }, auth: 'etagvis' });
    assertStatus(r, 200);
    assert.match(r.headers.get('etag'), /-ls-[0-9a-f]{8}"$/);
  });

  it('If-None-Match with the anon-visible ETag on an owner request → 200, not 304', async () => {
    const anon = await request(CONTAINER, { headers: { Accept: 'application/ld+json' } });
    const anonEtag = anon.headers.get('etag');
    const r = await request(CONTAINER, { headers: { Accept: 'application/ld+json', 'If-None-Match': anonEtag }, auth: 'etagvis' });
    assert.equal(r.status, 200, 'owner listing must not 304 off the anon-visible ETag');
  });

  it('matching If-None-Match on the owner listing still 304s', async () => {
    const asOwner = await request(CONTAINER, { headers: { Accept: 'application/ld+json' }, auth: 'etagvis' });
    const etag = asOwner.headers.get('etag');
    const r = await request(CONTAINER, { headers: { Accept: 'application/ld+json', 'If-None-Match': etag }, auth: 'etagvis' });
    assert.equal(r.status, 304);
  });

  it('HEAD and GET emit byte-identical listing ETags (lws+json, owner view)', async () => {
    const g = await request(CONTAINER, { headers: { Accept: 'application/lws+json' }, auth: 'etagvis' });
    const h = await request(CONTAINER, { method: 'HEAD', headers: { Accept: 'application/lws+json' }, auth: 'etagvis' });
    assertStatus(h, 200);
    assert.equal(h.headers.get('etag'), g.headers.get('etag'));
  });
});

describe('negative control: --lws off, ETags stay bare and byte-identical across formats', () => {
  let base;
  const DOC = '/etagneg/public/r.jsonld';
  const CONTAINER = '/etagneg/public/';

  before(async () => {
    await startTestServer({ lws: false, conneg: true });
    base = getBaseUrl();
    await createTestPod('etagneg');
    await request(DOC, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'etagneg',
      body: docBody(base, DOC) });
  });
  after(stopTestServer);

  it('file: Turtle and JSON-LD share the same bare ETag', async () => {
    const jsonld = await request(DOC, { headers: { Accept: 'application/ld+json' } });
    const ttl = await request(DOC, { headers: { Accept: 'text/turtle' } });
    assertStatus(jsonld, 200);
    assertStatus(ttl, 200);
    const etag = jsonld.headers.get('etag');
    assert.match(etag, BARE_ETAG_RE);
    assert.equal(ttl.headers.get('etag'), etag);
  });

  it('container listing: Turtle and JSON-LD share the same bare ETag', async () => {
    const ldjson = await request(CONTAINER, { headers: { Accept: 'application/ld+json' } });
    const ttl = await request(CONTAINER, { headers: { Accept: 'text/turtle' } });
    assertStatus(ldjson, 200);
    assertStatus(ttl, 200);
    const etag = ldjson.headers.get('etag');
    assert.match(etag, BARE_ETAG_RE);
    assert.equal(ttl.headers.get('etag'), etag);
  });
});

describe('lws: JSON-LD conversion arm ETag (review #5)', () => {
  let base;
  const TTL = '/etagj/public/r.ttl';
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    await createTestPod('etagj');
    await request(TTL, { method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, auth: 'etagj',
      body: '<#s> <http://ex/p> "v".' });
  });
  after(stopTestServer);

  it('the JSON-LD conversion of a .ttl source carries a -json variant ETag', async () => {
    const r = await request(TTL, { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    assert.match(r.headers.get('etag'), /-json"$/);
  });

  it('own-format .ttl GET keeps the bare ETag; the two variants differ', async () => {
    const ttl = await request(TTL, { headers: { Accept: 'text/turtle' } });
    const json = await request(TTL, { headers: { Accept: 'application/ld+json' } });
    assert.match(ttl.headers.get('etag'), BARE_ETAG_RE);
    assert.notEqual(ttl.headers.get('etag'), json.headers.get('etag'));
  });

  it('a Turtle-variant If-None-Match never 304s the JSON-LD variant (cross-variant)', async () => {
    const ttl = await request(TTL, { headers: { Accept: 'text/turtle' } });
    const r = await request(TTL, { headers: { Accept: 'application/ld+json', 'If-None-Match': ttl.headers.get('etag') } });
    assertStatus(r, 200);
  });

  it('same-variant If-None-Match still 304s', async () => {
    const json = await request(TTL, { headers: { Accept: 'application/ld+json' } });
    const r = await request(TTL, { headers: { Accept: 'application/ld+json', 'If-None-Match': json.headers.get('etag') } });
    assertStatus(r, 304);
    assert.match(r.headers.get('etag'), /-json"$/);
  });

  it('HEAD mirrors GET ETags on both arms', async () => {
    const g = await request(TTL, { headers: { Accept: 'application/ld+json' } });
    const h = await request(TTL, { method: 'HEAD', headers: { Accept: 'application/ld+json' } });
    assert.equal(h.headers.get('etag'), g.headers.get('etag'));
  });
});

describe('lws: representation-variant ETags under --lws without --conneg (review #5, task 4)', () => {
  // Task 4 fixed predictFileEtag so variant ETags are keyed even when --lws
  // is true and --conneg is false (previously the connegEnabled gate collapsed
  // every variant onto the bare ETag in that config). This describe block
  // exercises the --lws-without---conneg half of the fix: seeded .ttl source
  // yields distinct ETags for own-format (bare) vs JSON-LD conversion (-json).
  // PUT of RDF is rejected without conneg, so we use storage.write to seed the resource.
  let base;
  const TTL = '/etaglws/public/r.ttl';

  before(async () => {
    await startTestServer({ lws: true }); // conneg omitted/false
    base = getBaseUrl();
    await createTestPod('etaglws');
    // Seed via storage.write since PUT text/turtle is rejected without conneg
    await storage.write(TTL, Buffer.from('<#s> <http://ex/p> "v".'));
  });
  after(stopTestServer);

  it('JSON-LD conversion of a .ttl source carries a -json variant ETag under --lws alone', async () => {
    const r = await request(TTL, { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    assert.match(r.headers.get('etag'), /-json"$/);
  });

  it('own-format .ttl GET keeps the bare ETag; the two variants differ', async () => {
    const ttl = await request(TTL, { headers: { Accept: 'text/turtle' } });
    const json = await request(TTL, { headers: { Accept: 'application/ld+json' } });
    assert.match(ttl.headers.get('etag'), BARE_ETAG_RE);
    assert.notEqual(ttl.headers.get('etag'), json.headers.get('etag'));
  });

  it('a Turtle-variant If-None-Match never 304s the JSON-LD variant (cross-variant)', async () => {
    const ttl = await request(TTL, { headers: { Accept: 'text/turtle' } });
    const r = await request(TTL, { headers: { Accept: 'application/ld+json', 'If-None-Match': ttl.headers.get('etag') } });
    assertStatus(r, 200);
  });

  it('same-variant If-None-Match still 304s', async () => {
    const json = await request(TTL, { headers: { Accept: 'application/ld+json' } });
    const r = await request(TTL, { headers: { Accept: 'application/ld+json', 'If-None-Match': json.headers.get('etag') } });
    assertStatus(r, 304);
    assert.match(r.headers.get('etag'), /-json"$/);
  });
});
