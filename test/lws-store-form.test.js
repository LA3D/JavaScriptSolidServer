// test/lws-store-form.test.js
// The self-describing store form (spec 2026-07-10 §3): under --lws a
// multi-subject Turtle write stores {@context,@graph} (JSS's own generated-
// ACL envelope) instead of the legacy top-level array with @context on
// element 0 only. Single-subject docs and --lws-off pods are unchanged.
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

  it('multi-subject Turtle PUT stores the {@context,@graph} envelope', async () => {
    await request('/alice/public/multi.jsonld', {
      method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: TTL, auth: 'alice',
    });
    const r = await request('/alice/public/multi.jsonld', { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    const doc = await r.json();
    assert.ok(Array.isArray(doc['@graph']));
    assert.equal(doc['@graph'].length, 2);
    assert.ok(!Array.isArray(doc));                        // never the legacy top-level array
  });

  it('round-trip: Turtle PUT then Turtle GET returns both subjects (isomorphic content)', async () => {
    const r = await request('/alice/public/multi.jsonld', { headers: { Accept: 'text/turtle' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /"A"/);
    assert.match(body, /"B"/);
  });
});
