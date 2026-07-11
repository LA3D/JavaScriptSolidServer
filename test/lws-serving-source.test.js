// test/lws-serving-source.test.js
// Seam threading (spec 2026-07-11 §2): the serving arm receives the STORED
// content type — a .ttl serves its own bytes and converts correctly; plain
// application/json never enters the RDF arm (probe-#6 live repro: 200 empty Turtle).
//
// The .ttl fixture is written directly to storage (putFile), NOT via HTTP
// PUT: JSS's PUT pipeline normalizes any Turtle/N3 body to JSON-LD bytes on
// write whenever conneg is enabled (src/handlers/resource.js ~1421, pre-dates
// this round) — an HTTP PUT would never leave real Turtle bytes on disk, so
// it can't exercise the own-format short-circuit this test is pinning.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl, putFile } from './helpers.js';

describe('lws serving arm: sourceContentType threading', () => {
  let base;
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    await createTestPod('seamsrc');
    // A stored Turtle doc (multi-format source face) — real Turtle bytes on disk.
    await putFile(null, '/seamsrc/v.ttl', '<https://ex.org/s> <https://ex.org/p> "o" .');
    // A stored plain-JSON doc (the probe-#6 face)
    await request(`${base}/seamsrc/d.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, auth: 'seamsrc',
      body: JSON.stringify({ name: 'plain', n: 3 }) });
  });
  after(stopTestServer);

  it('stored .ttl requested as Turtle serves its own bytes (200, bytes-are-bytes)', async () => {
    const r = await request(`${base}/seamsrc/v.ttl`, { headers: { Accept: 'text/turtle' }, auth: 'seamsrc' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'text/turtle');
    assert.match(await r.text(), /<https:\/\/ex\.org\/s> <https:\/\/ex\.org\/p> "o"/);
  });

  it('stored .ttl requested as N-Quads converts with real triples', async () => {
    const r = await request(`${base}/seamsrc/v.ttl`, { headers: { Accept: 'application/n-quads' }, auth: 'seamsrc' });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /<https:\/\/ex\.org\/s> <https:\/\/ex\.org\/p> "o" \./);
  });

  it('stored plain .json requested with no Accept serves application/json, correctly labeled', async () => {
    const r = await request(`${base}/seamsrc/d.json`, { auth: 'seamsrc' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/json');
  });

  it('stored plain .json requested as Turtle NEVER yields empty-Turtle 200 (406 comes in Task 2)', async () => {
    const r = await request(`${base}/seamsrc/d.json`, { headers: { Accept: 'text/turtle' }, auth: 'seamsrc' });
    // Task 1 pins only the seam: no 200-with-text/turtle-and-zero-triples.
    const ct = (r.headers.get('content-type') || '').split(';')[0];
    assert.ok(!(r.status === 200 && ct === 'text/turtle'), `got the probe-#6 signature: 200 ${ct}`);
  });

  it('HEAD parity: stored .ttl as N-Quads reports the converted type', async () => {
    const r = await request(`${base}/seamsrc/v.ttl`, { method: 'HEAD', headers: { Accept: 'application/n-quads' }, auth: 'seamsrc' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/n-quads');
  });
});
