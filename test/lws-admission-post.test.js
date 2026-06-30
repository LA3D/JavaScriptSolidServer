// test/lws-admission-post.test.js
// Integration test: SHACL member-rule admission wired into handlePost.
// RED before Task 6; GREEN after.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl,
} from './helpers.js';

// Shape stored as JSON-LD with explicit blank-node ID for sh:property so that
// JSS's jsonLdToQuads emits all four property-restriction triples.
// Anonymous inline blank nodes are silently dropped by the JSON-LD→quads path.
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

async function provision() {
  const base = getBaseUrl();
  // Create feed container
  await request('/alice/public/feed/', { method: 'PUT', auth: 'alice' });
  // Store SHACL shape (JSON-LD, accepted regardless of conneg)
  await request('/alice/public/shapes/Note', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: SHAPE_LD,
    auth: 'alice',
  });
  // Container .meta declares member-rule via powder-s:describedby
  await request('/alice/public/feed/.meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify({
      '@id': `${base}/alice/public/feed/`,
      [DESCRIBEDBY]: { '@id': `${base}/alice/public/shapes/Note` },
    }),
    auth: 'alice',
  });
}

// ── lws:ON suite ────────────────────────────────────────────────────────────

describe('SHACL member-rule admission on POST (lws:ON)', () => {
  before(async () => {
    await startTestServer({ lws: true });
    await createTestPod('alice');
    await provision();
  });

  after(async () => { await stopTestServer(); });

  it('POST non-conforming member into constrained container → 400 problem+json + describedby Link', async () => {
    const base = getBaseUrl();
    const res = await request('/alice/public/feed/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        'Slug': 'p1',
      },
      // ex:Note with no ex:title → violates sh:minCount 1
      body: JSON.stringify({
        '@context': { 'ex': 'http://ex/' },
        '@id': `${base}/alice/public/feed/p1`,
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

  it('POST conforming member into constrained container → 201', async () => {
    const base = getBaseUrl();
    const res = await request('/alice/public/feed/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        'Slug': 'p2',
      },
      // ex:Note WITH ex:title → conforms
      body: JSON.stringify({
        '@context': { 'ex': 'http://ex/' },
        '@id': `${base}/alice/public/feed/p2`,
        '@type': 'ex:Note',
        'ex:title': 'hello',
      }),
      auth: 'alice',
    });
    assert.equal(res.status, 201, `Expected 201, got ${res.status}`);
  });
});
