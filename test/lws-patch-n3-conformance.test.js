// test/lws-patch-n3-conformance.test.js
// Task 8 — three Solid N3-Patch conformance gaps:
//   (1) a delete of a triple ABSENT from the target graph is a 409 Conflict,
//       not a silent no-op (dataset/Turtle path: patchDeletesExist; JSON-LD
//       path: validatePatch).
//   (2) a non-empty solid:where binds a SINGLE solution into deletes/inserts;
//       zero/multiple solutions → 409 (dataset path). The JSON-LD-document path
//       takes the sanctioned FLOOR: a where-carrying patch is rejected 409
//       rather than applied unconditionally.
//   (3) blank-node SUBJECTS in the JSON-LD path insert (mint a `_:` @id) and
//       delete (structural match) correctly.
// https://solid.github.io/specification/protocol#n3-patch
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl } from './helpers.js';

const DCT = 'http://purl.org/dc/terms/';
const FOAF = 'http://xmlns.com/foaf/0.1/';

describe('N3-Patch conformance (Task 8)', () => {
  let base;
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    await createTestPod('alice');
    base = getBaseUrl();
  });
  after(async () => { await stopTestServer(); });

  const put = (path, ct, body) =>
    request(path, { method: 'PUT', auth: 'alice', headers: { 'Content-Type': ct }, body });
  const patch = (path, body) =>
    request(path, { method: 'PATCH', auth: 'alice', headers: { 'Content-Type': 'text/n3' }, body });
  const text = async (path, accept) =>
    (await request(path, { auth: 'alice', headers: accept ? { Accept: accept } : {} })).text();

  // ── gap 1: delete-of-nonexistent → 409 ─────────────────────────────────────

  it('delete of a NON-EXISTENT triple on a .ttl is 409, not a silent no-op (dataset path)', async () => {
    await put('/alice/pub/g1.ttl', 'text/turtle', `<#it> <${DCT}title> "Old".`);
    const body = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
_:p a solid:InsertDeletePatch;
  solid:deletes { <${base}/alice/pub/g1.ttl#it> <${DCT}title> "NOT THERE" }.`;
    const res = await patch('/alice/pub/g1.ttl', body);
    assert.equal(res.status, 409, `delete-of-nonexistent must 409, got ${res.status}`);
    // original untouched
    assert.match(await text('/alice/pub/g1.ttl', 'text/turtle'), /"Old"/);
  });

  it('delete of a NON-EXISTENT triple on a .jsonld is 409, not a silent no-op (JSON-LD path)', async () => {
    await put('/alice/pub/g1.jsonld', 'application/ld+json', JSON.stringify({
      '@graph': [{ '@id': '#it', [`${DCT}title`]: 'Old' }],
    }));
    const body = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
_:p a solid:InsertDeletePatch;
  solid:deletes { <${base}/alice/pub/g1.jsonld#it> <${DCT}title> "NOT THERE" }.`;
    const res = await patch('/alice/pub/g1.jsonld', body);
    assert.equal(res.status, 409, `delete-of-nonexistent (JSON-LD) must 409, got ${res.status}`);
  });

  // ── gap 2: solid:where single-solution semantics ───────────────────────────

  it('solid:where with ONE solution binds it and applies (dataset path)', async () => {
    await put('/alice/pub/w1.ttl', 'text/turtle', `<#it> <${DCT}title> "Old".`);
    const body = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix dct: <${DCT}>.
_:p a solid:InsertDeletePatch;
  solid:where   { <${base}/alice/pub/w1.ttl#it> dct:title ?t };
  solid:deletes { <${base}/alice/pub/w1.ttl#it> dct:title ?t };
  solid:inserts { <${base}/alice/pub/w1.ttl#it> dct:title "New" }.`;
    const res = await patch('/alice/pub/w1.ttl', body);
    assert.ok([200, 204].includes(res.status), `where-single-solution should apply, got ${res.status}`);
    const ttl = await text('/alice/pub/w1.ttl', 'text/turtle');
    assert.match(ttl, /"New"/, 'the bound title should be updated to "New"');
    assert.doesNotMatch(ttl, /"Old"/, 'the old title should be gone');
  });

  it('solid:where with MULTIPLE solutions is 409 and does NOT apply (dataset path)', async () => {
    // two dct:title values → ?t binds two ways → ambiguous → reject.
    await put('/alice/pub/w2.ttl', 'text/turtle',
      `<#it> <${DCT}title> "Old", "Older".`);
    const body = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix dct: <${DCT}>.
_:p a solid:InsertDeletePatch;
  solid:where   { <${base}/alice/pub/w2.ttl#it> dct:title ?t };
  solid:deletes { <${base}/alice/pub/w2.ttl#it> dct:title ?t };
  solid:inserts { <${base}/alice/pub/w2.ttl#it> dct:title "New" }.`;
    const res = await patch('/alice/pub/w2.ttl', body);
    assert.equal(res.status, 409, `multi-solution where must 409, got ${res.status}`);
    const ttl = await text('/alice/pub/w2.ttl', 'text/turtle');
    assert.doesNotMatch(ttl, /"New"/, 'a rejected conditional patch must NOT apply its inserts');
    assert.match(ttl, /"Old"/, 'the original data must survive the rejection');
    assert.match(ttl, /"Older"/, 'the original data must survive the rejection');
  });

  it('solid:where with ZERO solutions is 409 and does NOT apply (dataset path, multi-pattern join)', async () => {
    await put('/alice/pub/w3.ttl', 'text/turtle', `<#it> <${DCT}title> "Old".`);
    // second pattern matches nothing → join yields zero solutions.
    const body = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix dct: <${DCT}>.
_:p a solid:InsertDeletePatch;
  solid:where   { <${base}/alice/pub/w3.ttl#it> dct:title ?t .
                  <${base}/alice/pub/w3.ttl#it> <http://ex/absent> ?z };
  solid:deletes { <${base}/alice/pub/w3.ttl#it> dct:title "Old" };
  solid:inserts { <${base}/alice/pub/w3.ttl#it> dct:title "New" }.`;
    const res = await patch('/alice/pub/w3.ttl', body);
    assert.equal(res.status, 409, `zero-solution where must 409, got ${res.status}`);
    const ttl = await text('/alice/pub/w3.ttl', 'text/turtle');
    assert.doesNotMatch(ttl, /"New"/, 'a rejected conditional patch must NOT apply its inserts');
    assert.match(ttl, /"Old"/, 'the original data must survive the rejection');
  });

  it('solid:where on a .jsonld is 409 (FLOOR) and does NOT apply (JSON-LD path)', async () => {
    await put('/alice/pub/wj.jsonld', 'application/ld+json', JSON.stringify({
      '@context': { dct: DCT }, '@graph': [{ '@id': '#it', 'dct:title': 'Old' }],
    }));
    const body = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix dct: <${DCT}>.
_:p a solid:InsertDeletePatch;
  solid:where   { <${base}/alice/pub/wj.jsonld#it> dct:title ?t };
  solid:inserts { <${base}/alice/pub/wj.jsonld#it> dct:title "New" }.`;
    const res = await patch('/alice/pub/wj.jsonld', body);
    assert.equal(res.status, 409, `where on JSON-LD path must 409 (floor), got ${res.status}`);
    const json = await text('/alice/pub/wj.jsonld', 'application/ld+json');
    assert.doesNotMatch(json, /"New"/, 'the floor must NOT apply the conditional patch');
  });

  // ── gap 3: blank-node SUBJECTS in the JSON-LD path ─────────────────────────

  it('inserts a triple with a blank-node SUBJECT, minting a _: @id (JSON-LD path)', async () => {
    await put('/alice/pub/bn.jsonld', 'application/ld+json', JSON.stringify({
      '@context': { foaf: FOAF }, '@graph': [{ '@id': '#it', 'foaf:name': 'Root' }],
    }));
    const body = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix foaf: <${FOAF}>.
_:p a solid:InsertDeletePatch;
  solid:inserts { _:b0 foaf:name "Blanky" }.`;
    const res = await patch('/alice/pub/bn.jsonld', body);
    assert.ok([200, 204].includes(res.status), `blank-subject insert should apply, got ${res.status}`);
    const json = await text('/alice/pub/bn.jsonld', 'application/ld+json');
    assert.match(json, /"Blanky"/, 'the inserted object should be present');
    assert.match(json, /_:/, 'the blank-node subject should be a `_:`-prefixed @id');
    assert.doesNotMatch(json, /blankNode/, 'the {blankNode} marker must not leak into stored JSON-LD');
  });

  it('deletes a triple with a blank-node SUBJECT via structural match (JSON-LD path)', async () => {
    await put('/alice/pub/bd.jsonld', 'application/ld+json', JSON.stringify({
      '@context': { foaf: FOAF },
      '@graph': [{ '@id': '#it', 'foaf:name': 'Root' }, { '@id': '_:b0', 'foaf:name': 'Blanky' }],
    }));
    const body = `@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix foaf: <${FOAF}>.
_:p a solid:InsertDeletePatch;
  solid:deletes { _:b0 foaf:name "Blanky" }.`;
    const res = await patch('/alice/pub/bd.jsonld', body);
    assert.ok([200, 204].includes(res.status), `blank-subject delete should apply, got ${res.status}`);
    const json = await text('/alice/pub/bd.jsonld', 'application/ld+json');
    assert.doesNotMatch(json, /"Blanky"/, 'the blank-node-subject triple should have been deleted');
    assert.match(json, /"Root"/, 'the unrelated triple should survive');
  });
});
