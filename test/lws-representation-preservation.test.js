// test/lws-representation-preservation.test.js
// Spec §2: under --lws the pod stores exactly what the client submitted; the LWS read
// binding requires "content is exactly the stored data" + "Content-Type matching the
// stored media type", and container items[].mediaType MUST agree. So a .ttl PUT as
// text/turtle is stored AS Turtle (no JSON-LD envelope), served as its own bytes, and
// negotiable to JSON-LD via real conversion.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getPodToken, getBaseUrl } from './helpers.js';
const TTL = '@prefix ex: <http://ex/> .\nex:s ex:p "o" .\nex:s2 ex:p "o2" .';

describe('representation preservation (--lws)', () => {
  let base, tok;
  before(async () => {
    await startTestServer({ lws: true });
    base = getBaseUrl();
    await createTestPod('rp');
    tok = getPodToken('rp');
  });
  after(stopTestServer);
  const H = (ct) => ({ authorization: `Bearer ${tok}`, 'content-type': ct });

  it('multi-subject Turtle PUT is stored AS Turtle, served as its own bytes', async () => {
    const p = await request(`${base}/rp/v.ttl`, { method: 'PUT', headers: H('text/turtle'), body: TTL });
    assert.ok([200, 201, 204, 205].includes(p.status));
    const g = await request(`${base}/rp/v.ttl`, { headers: { authorization: `Bearer ${tok}`, accept: 'text/turtle' } });
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type').split(';')[0], 'text/turtle');
    const body = await g.text();
    assert.ok(!body.trimStart().startsWith('{') && !body.trimStart().startsWith('['), 'stored as Turtle, not a JSON-LD envelope');
    assert.match(body, /ex:p "o"/);
  });

  it('the stored Turtle negotiates to JSON-LD via real conversion', async () => {
    const g = await request(`${base}/rp/v.ttl`, { headers: { authorization: `Bearer ${tok}`, accept: 'application/ld+json' } });
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('content-type').split(';')[0], 'application/ld+json');
    const doc = await g.json();
    assert.ok(JSON.stringify(doc).includes('http://ex/p'));
  });

  // Task 7: items[].mediaType is derived from getContentType — now uses
  // Solid-aware getContentType() for sidecar and RDF type resolution.
  it('items[] mediaType agrees with the stored Turtle type', async () => {
    const l = await request(`${base}/rp/`, { headers: { authorization: `Bearer ${tok}`, accept: 'application/lws+json' } });
    const item = (await l.json()).items.find(i => i.id.endsWith('/v.ttl'));
    assert.equal(item.mediaType, 'text/turtle');
  });

  it('name/type mismatch → teaching 400', async () => {
    const r = await request(`${base}/rp/x.jsonld`, { method: 'PUT', headers: H('text/turtle'), body: TTL });
    assert.equal(r.status, 400);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/problem+json');
    assert.match((await r.json()).detail, /text\/turtle|\.ttl|application\/ld\+json/);
  });

  // B1 gate hole (fix round 1): a JSON-LD body at a .ttl name is the same
  // name/type lie in the other direction — it would store JSON-LD bytes yet
  // serve them as text/turtle. Rejected with the teaching 400.
  it('JSON-LD body at a .ttl name → teaching 400', async () => {
    const JLD = JSON.stringify({ '@id': 'http://ex/s', 'http://ex/p': 'o' });
    const r = await request(`${base}/rp/lie.ttl`, { method: 'PUT', headers: H('application/ld+json'), body: JLD });
    assert.equal(r.status, 400);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/problem+json');
    assert.match((await r.json()).detail, /text\/turtle|\.ttl|application\/ld\+json/);
  });

  it('extension-less RDF write → teaching 400 (would serve octet-stream)', async () => {
    const r = await request(`${base}/rp/noext`, { method: 'PUT', headers: H('text/turtle'), body: TTL });
    assert.equal(r.status, 400);
  });
});
