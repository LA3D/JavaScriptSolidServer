// test/lws-serving-path-negative.test.js
// NEGATIVE CONTROL (spec 2026-07-10 §1): a --conneg-only pod (no --lws)
// keeps the legacy hand-rolled serving arm byte-identically — including its
// documented defect (a @graph doc converts to prefix-only Turtle with zero
// triples). This test pins the legacy behavior so un-gating is a deliberate
// decision, not an accident.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

const DOC = '/alice/public/servepath-neg.jsonld';

describe('negative control: --lws off keeps the legacy serving arm', () => {
  before(async () => {
    await startTestServer({ lws: false, conneg: true });
    await createTestPod('alice');
    const base = getBaseUrl();
    await request(DOC, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@context': { name: 'https://schema.org/name' }, '@graph': [
        { '@id': `${base}${DOC}#a`, name: 'A' }] }) });
  });
  after(async () => { await stopTestServer(); });

  it('@graph doc as Turtle → legacy 200 with no triples (upstream behavior, unchanged)', async () => {
    const res = await request(DOC, { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 200);
    const body = await res.text();
    assert.ok(!body.includes('"A"'));
  });

  it('n-quads is NOT negotiable without --lws (JSON-LD default served)', async () => {
    const res = await request(DOC, { headers: { Accept: 'application/n-quads' } });
    assertStatus(res, 200);
    assert.match(res.headers.get('content-type'), /application\/ld\+json/);
  });

  it('multi-subject Turtle PUT stores the LEGACY array form without --lws', async () => {
    await request('/alice/public/multi-neg.jsonld', {
      method: 'PUT', headers: { 'Content-Type': 'text/turtle' },
      body: '@prefix schema: <https://schema.org/>.\n<#a> schema:name "A".\n<#b> schema:name "B".',
      auth: 'alice',
    });
    const r = await request('/alice/public/multi-neg.jsonld', { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    const doc = await r.json();
    assert.ok(Array.isArray(doc));                          // legacy array — byte-discipline held
  });
});
