// test/lws-store-form.test.js
// B1 root fix (spec 2026-07-11 §2) superseded the store-form-conversion design
// this file originally pinned: under --lws a Turtle write now stores exactly
// what the client submitted (raw Turtle on disk), never a JSON-LD envelope —
// see test/lws-representation-preservation.test.js for that behavior. The
// {@context,@graph} envelope form (JSS's own generated-ACL shape) still exists,
// but only for a JSON-LD-submitted write (the client's own choice, stored
// verbatim) — the unit test below exercises turtleToJsonLd(graphEnvelope:true)
// directly (the function itself is still live — the --lws-off legacy write
// path calls it with graphEnvelope:false, src/handlers/resource.js), not a
// live Turtle-PUT write path under --lws.
import { describe, it, before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, assertStatus,
} from './helpers.js';
import { turtleToJsonLd } from '../src/rdf/turtle.js';
import { extractCertKeys } from '../src/auth/webid-tls.js';

const TTL = '@prefix schema: <https://schema.org/>.\n<#a> schema:name "A".\n<#b> schema:name "B".';

test('turtleToJsonLd: graphEnvelope option emits {@context,@graph}; default stays legacy array', async () => {
  const env = await turtleToJsonLd(TTL, 'https://pod.example/m', { graphEnvelope: true });
  assert.ok(Array.isArray(env['@graph']));
  assert.equal(env['@graph'].length, 2);
  assert.ok(env['@context']);
  const legacy = await turtleToJsonLd(TTL, 'https://pod.example/m');
  assert.ok(Array.isArray(legacy));                       // legacy array — unchanged
  const single = await turtleToJsonLd('<#a> <https://schema.org/name> "A".', 'https://pod.example/m', { graphEnvelope: true });
  assert.equal(single['@graph'], undefined);              // single subject: {@context, ...node}
  assert.equal(single['@id'], '#a');
});

test('extractCertKeys unwraps a {@context,@graph} profile (webid-tls consumer fix)', () => {
  const doc = { '@context': { cert: 'http://www.w3.org/ns/auth/cert#' }, '@graph': [{
    '@id': 'https://ex.org/profile#me',
    'cert:key': { 'cert:modulus': 'abc123', 'cert:exponent': 65537 },
  }] };
  const keys = extractCertKeys(doc, 'https://ex.org/profile#me');
  assert.equal(keys.length, 1);
  // Control: the same nodes passed as a bare array must give the same result.
  assert.equal(extractCertKeys(doc['@graph'], 'https://ex.org/profile#me').length, keys.length);
});

describe('store form over HTTP (--lws pod)', () => {
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    await createTestPod('alice');
  });
  after(async () => { await stopTestServer(); });

  // Spec 2026-07-11 §2 (B1 root fix): under --lws the write path no longer
  // converts Turtle to a JSON-LD envelope — the pod stores exactly what the
  // client submitted. A .ttl PUT stays raw Turtle on disk; the envelope
  // {@context,@graph} form (pinned by the unit test above) now only ever
  // shows up for a JSON-LD-submitted write, never as a Turtle-write side effect.
  it('multi-subject Turtle PUT is stored AS Turtle (no envelope conversion)', async () => {
    await request('/alice/public/multi.ttl', {
      method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: TTL, auth: 'alice',
    });
    const r = await request('/alice/public/multi.ttl', { headers: { Accept: 'text/turtle' } });
    assertStatus(r, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'text/turtle');
    const body = await r.text();
    assert.ok(!body.trimStart().startsWith('{') && !body.trimStart().startsWith('['), 'stored as Turtle, not JSON');
    assert.match(body, /"A"/);
    assert.match(body, /"B"/);
  });

  it('the stored Turtle negotiates to real JSON-LD via the dataset seam on Accept: application/ld+json', async () => {
    const r = await request('/alice/public/multi.ttl', { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'application/ld+json');
    const doc = await r.json();
    assert.ok(Array.isArray(doc));                          // expanded form: array of nodes, no envelope
    assert.equal(doc.length, 2);
    const names = doc.flatMap((n) => (n['https://schema.org/name'] || []).map((v) => v['@value']));
    assert.ok(names.includes('A') && names.includes('B'));
  });

  it('round-trip: Turtle PUT then Turtle GET returns both subjects (isomorphic content)', async () => {
    const r = await request('/alice/public/multi.ttl', { headers: { Accept: 'text/turtle' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /"A"/);
    assert.match(body, /"B"/);
  });
});
