// test/lws-patch-admission.test.js
// Task 6: PATCH routes through applyLwsWrite — SHACL admission holds on the
// PATCH surface (not just PUT/POST) and .lwstypes re-derives from the patched
// bytes. RED before the routing change (today a shape-violating PATCH 204s and
// .lwstypes stays stale); GREEN after.
//
// Fixture wiring mirrors test/lws-admission-put.test.js (container .meta →
// powder-s:describedby → a title-required NodeShape), adapted to neutral ex:
// terms. Two write branches are covered:
//   (a) Turtle-family member (.ttl) → patchTurtleFamilyResource
//   (b) JSON-LD-document member (.jsonld) → the legacy JSON-LD branch
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl,
} from './helpers.js';

const EX = 'https://example.org/ex#';
const DCT_TITLE = 'http://purl.org/dc/terms/title';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';

// NodeShape: ex:Thing MUST carry dct:title (sh:minCount 1, Violation). Explicit
// blank-node @id on sh:property so JSS's jsonLdToQuads emits all restriction
// triples (same trick as lws-admission-put.test.js).
const SHAPE_LD = JSON.stringify({
  '@context': { 'sh': 'http://www.w3.org/ns/shacl#' },
  '@id': `${EX}ThingShape`,
  '@type': 'sh:NodeShape',
  'sh:targetClass': { '@id': `${EX}Thing` },
  'sh:property': {
    '@id': '_:p1',
    'sh:path': { '@id': DCT_TITLE },
    'sh:minCount': 1,
    'sh:severity': { '@id': 'http://www.w3.org/ns/shacl#Violation' },
    'sh:message': 'title required',
  },
});

// Provision: governed container whose .meta names the shape as a member-rule.
async function provision() {
  const base = getBaseUrl();
  await request('/alice/public/governed/', { method: 'PUT', auth: 'alice' });
  await request('/alice/public/shapes/Thing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: SHAPE_LD,
    auth: 'alice',
  });
  await request('/alice/public/governed/.meta', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify({
      '@id': `${base}/alice/public/governed/`,
      [DESCRIBEDBY]: { '@id': `${base}/alice/public/shapes/Thing` },
    }),
    auth: 'alice',
  });
}

describe('PATCH routes through applyLwsWrite (admission + type reindex)', () => {
  let base;
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    await createTestPod('alice');
    base = getBaseUrl();
    await provision();
    // Conforming Turtle member (has the required title) — admits on PUT.
    const put = await request('/alice/public/governed/thing.ttl', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: `@prefix ex: <${EX}>.\n@prefix dct: <http://purl.org/dc/terms/>.\n`
        + `<#it> a ex:Thing; dct:title "T".`,
      auth: 'alice',
    });
    assert.ok([200, 201, 204].includes(put.status), `fixture PUT .ttl ${put.status}`);
  });
  after(async () => { await stopTestServer(); });

  // ── branch (a): Turtle-family ──────────────────────────────────────────────

  it('a Turtle PATCH that violates the container shape is rejected 400', async () => {
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n`
      + `_:p a solid:InsertDeletePatch;\n`
      + `  solid:deletes { <${base}/alice/public/governed/thing.ttl#it> <${DCT_TITLE}> "T" }.`;
    const res = await request('/alice/public/governed/thing.ttl', {
      method: 'PATCH', headers: { 'Content-Type': 'text/n3' }, auth: 'alice', body: patch,
    });
    assert.equal(res.status, 400, `shape-violating PATCH must 400, got ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    assert.match(ct, /application\/problem\+json/, `expected problem+json, got ${ct}`);
  });

  it('a Turtle PATCH mutating rdf:type refreshes .lwstypes', async () => {
    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n`
      + `_:p a solid:InsertDeletePatch;\n`
      + `  solid:inserts { <${base}/alice/public/governed/thing.ttl#it> <${RDF_TYPE}> <${EX}Extra> }.`;
    const res = await request('/alice/public/governed/thing.ttl', {
      method: 'PATCH', headers: { 'Content-Type': 'text/n3' }, auth: 'alice', body: patch,
    });
    assert.ok([200, 204].includes(res.status), `type-add PATCH ${res.status}`);
    const types = await request('/alice/public/governed/thing.ttl.lwstypes', { auth: 'alice' });
    const body = await types.text();
    assert.match(body, /example\.org\/ex#Extra/, `.lwstypes must carry the new type, got: ${body}`);
  });

  // ── branch (b): JSON-LD document ───────────────────────────────────────────

  it('a JSON-LD PATCH that violates the container shape is rejected 400', async () => {
    // Conforming JSON-LD member (full-URI keys so N3-patch predicate matching
    // is unambiguous), then delete the title → violates the shape.
    const put = await request('/alice/public/governed/jthing.jsonld', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@id': `${base}/alice/public/governed/jthing.jsonld`,
        '@type': `${EX}Thing`,
        [DCT_TITLE]: 'T',
      }),
      auth: 'alice',
    });
    assert.ok([200, 201, 204].includes(put.status), `fixture PUT .jsonld ${put.status}`);

    const patch = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n`
      + `_:p a solid:InsertDeletePatch;\n`
      + `  solid:deletes { <${base}/alice/public/governed/jthing.jsonld> <${DCT_TITLE}> "T" }.`;
    const res = await request('/alice/public/governed/jthing.jsonld', {
      method: 'PATCH', headers: { 'Content-Type': 'text/n3' }, auth: 'alice', body: patch,
    });
    assert.equal(res.status, 400, `shape-violating JSON-LD PATCH must 400, got ${res.status}`);
  });
});
