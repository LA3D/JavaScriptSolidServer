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

// ── advisory-body path suite ─────────────────────────────────────────────────
// Verifies the ADMIT decision when only Warning/Info constraints fire:
// handler must return 201/200 with advisories in the JSON body and MUST NOT
// set a Warning header (RFC 9111 obsoletes it).

// Shape has two property constraints:
//   _:p1  ex:title  Violation  minCount 1   ← resource WILL satisfy this
//   _:p2  ex:desc   Info       minCount 1   ← resource will NOT (triggers advisory)
// Both blank nodes carry an explicit @id so JSS's jsonLdToQuads enqueues them.
const ADVISORY_SHAPE_LD = JSON.stringify({
  '@context': { 'sh': 'http://www.w3.org/ns/shacl#', 'ex': 'http://ex/' },
  '@id': 'http://ex/AdvisoryNoteShape',
  '@type': 'sh:NodeShape',
  'sh:targetClass': { '@id': 'http://ex/Note' },
  'sh:property': [
    {
      '@id': '_:p1',
      'sh:path': { '@id': 'http://ex/title' },
      'sh:minCount': 1,
      'sh:severity': { '@id': 'http://www.w3.org/ns/shacl#Violation' },
      'sh:message': 'title required',
    },
    {
      '@id': '_:p2',
      'sh:path': { '@id': 'http://ex/desc' },
      'sh:minCount': 1,
      'sh:severity': { '@id': 'http://www.w3.org/ns/shacl#Info' },
      'sh:message': 'consider a description',
    },
  ],
});

describe('SHACL admission advisory-body path (lws:ON)', () => {
  before(async () => {
    await startTestServer({ lws: true });
    await createTestPod('alice');
    const base = getBaseUrl();
    // advisory-notes container + shape + container .meta
    await request('/alice/public/advisory-notes/', { method: 'PUT', auth: 'alice' });
    await request('/alice/public/shapes/AdvisoryNote', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: ADVISORY_SHAPE_LD,
      auth: 'alice',
    });
    await request('/alice/public/advisory-notes/.meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@id': `${base}/alice/public/advisory-notes/`,
        [DESCRIBEDBY]: { '@id': `${base}/alice/public/shapes/AdvisoryNote` },
      }),
      auth: 'alice',
    });
  });

  after(async () => { await stopTestServer(); });

  it('PUT conforming-on-Violation but missing Info property → 201 + advisories body + no Warning header', async () => {
    const base = getBaseUrl();
    const res = await request('/alice/public/advisory-notes/a1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      // ex:Note WITH ex:title (satisfies Violation) but NO ex:desc (trips Info constraint)
      body: JSON.stringify({
        '@context': { 'ex': 'http://ex/' },
        '@id': `${base}/alice/public/advisory-notes/a1`,
        '@type': 'ex:Note',
        'ex:title': 'My Note',
      }),
      auth: 'alice',
    });
    assert.ok(res.status === 201 || res.status === 200, `Expected 201 (new) or 200 (existing), got ${res.status}`);
    const body = await res.json();
    assert.ok(
      Array.isArray(body.advisories) && body.advisories.length > 0,
      `Expected non-empty advisories array in body, got ${JSON.stringify(body)}`,
    );
    const adv = body.advisories[0];
    assert.ok(
      adv.severity === 'Info' || adv.severity === 'Warning',
      `Expected advisory severity Info or Warning, got ${adv.severity}`,
    );
    assert.ok(
      typeof adv.message === 'string' && adv.message.includes('description'),
      `Expected advisory message to include "description", got ${adv.message}`,
    );
    assert.equal(res.headers.get('warning'), null, 'Warning header must be absent (RFC 9111 obsoletes it)');
    const link = res.headers.get('link') || '';
    assert.match(link, /rel="describedby"/, `Link header missing rel="describedby": ${link}`);
  });
});
