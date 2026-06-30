// test/lws-admission-put.test.js
// Integration test: SHACL admission wired into handlePut.
// RED before Task 5; GREEN after.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl,
} from './helpers.js';

// Shape stored as JSON-LD with explicit blank-node ID for sh:property so that
// the JSS conneg serializer (jsonLdToQuads) emits all four property-restriction
// triples. Absolute IRIs avoid base-relative resolution issues in valueToTerm.
const SHAPE_LD = JSON.stringify({
  '@context': { 'sh': 'http://www.w3.org/ns/shacl#', 'ex': 'http://ex/' },
  '@id': 'http://ex/NoteShape',
  '@type': 'sh:NodeShape',
  'sh:targetClass': { '@id': 'http://ex/Note' },
  'sh:property': {
    '@id': '_:p1',
    'sh:path': { '@id': 'http://ex/title' },
    'sh:minCount': 1,
    'sh:severity': { '@id': 'http://www.w3.org/ns/shacl#Violation' },
    'sh:message': 'title required',
  },
});

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';

// Provision shape + container meta; called inside each before() hook.
// getBaseUrl() is valid only after startTestServer() resolves.
async function provision() {
  const base = getBaseUrl();
  // Create the notes container
  await request('/alice/public/notes/', { method: 'PUT', auth: 'alice' });
  // Store the SHACL shape (JSON-LD, always accepted regardless of conneg)
  await request('/alice/public/shapes/Note', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: SHAPE_LD,
    auth: 'alice',
  });
  // Container .meta declares the shape as a member-rule via powder-s:describedby
  await request('/alice/public/notes/.meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify({
      '@id': `${base}/alice/public/notes/`,
      [DESCRIBEDBY]: { '@id': `${base}/alice/public/shapes/Note` },
    }),
    auth: 'alice',
  });
}

// ── lws:ON suite ────────────────────────────────────────────────────────────

describe('SHACL admission wired into handlePut (lws:ON)', () => {
  before(async () => {
    await startTestServer({ lws: true });
    await createTestPod('alice');
    await provision();
  });

  after(async () => { await stopTestServer(); });

  it('PUT non-conforming resource → 400 problem+json + describedby Link', async () => {
    const base = getBaseUrl();
    const res = await request('/alice/public/notes/n1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      // ex:Note with NO ex:title → violates sh:minCount 1
      body: JSON.stringify({
        '@context': { 'ex': 'http://ex/' },
        '@id': `${base}/alice/public/notes/n1`,
        '@type': 'ex:Note',
      }),
      auth: 'alice',
    });
    assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    assert.match(ct, /application\/problem\+json/);
    const link = res.headers.get('link') || '';
    assert.match(link, /rel="describedby"/, `Link header missing rel="describedby": ${link}`);
    const body = await res.json();
    assert.equal(body.status, 400);
    assert.ok(
      Array.isArray(body.violations) && body.violations.some(v => v.message === 'title required'),
      `Expected violation "title required" in ${JSON.stringify(body.violations)}`,
    );
  });

  it('PUT conforming resource → 201 + describedby Link', async () => {
    const base = getBaseUrl();
    const res = await request('/alice/public/notes/n2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      // ex:Note WITH ex:title → conforms
      body: JSON.stringify({
        '@context': { 'ex': 'http://ex/' },
        '@id': `${base}/alice/public/notes/n2`,
        '@type': 'ex:Note',
        'ex:title': 'hi',
      }),
      auth: 'alice',
    });
    assert.ok(res.status === 201 || res.status === 204, `Expected 201/204, got ${res.status}`);
    const link = res.headers.get('link') || '';
    assert.match(link, /rel="describedby"/, `Link header missing rel="describedby": ${link}`);
  });
});

// ── lws:OFF negative-control suite ──────────────────────────────────────────
// Server is a singleton; separate describe block with its own before/after
// so it gets its own server lifecycle (stop the lws:ON server, start lws:OFF).

describe('SHACL admission negative control (lws:OFF)', () => {
  before(async () => {
    await startTestServer({ lws: false });
    await createTestPod('alice');
    await provision();   // same setup — constraint would fire if admission were wired
  });

  after(async () => { await stopTestServer(); });

  it('same bad PUT with lws:OFF → 201/204 (admission gate inactive)', async () => {
    const base = getBaseUrl();
    const res = await request('/alice/public/notes/n1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { 'ex': 'http://ex/' },
        '@id': `${base}/alice/public/notes/n1`,
        '@type': 'ex:Note',
      }),
      auth: 'alice',
    });
    assert.ok(res.status === 201 || res.status === 204, `Expected 201/204 but got ${res.status}`);
  });
});
