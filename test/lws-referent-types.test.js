// test/lws-referent-types.test.js
// Referent identity & discovery (2026-07-13): a stored RDF resource is indexed
// by its subject's rdf:type ALONGSIDE lws#DataResource — enrich, not replace.
// LWS lws10-searchindex §Type-and-Relation-Derivation ¶2 (content derivation).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, request, startTestServer, stopTestServer, createTestPod, getPodToken, getBaseUrl } from './helpers.js';

const CONCEPT = 'https://example.org/ex#Thing';   // neutral ex: type, no app vocabulary
const DATARES = 'https://www.w3.org/ns/lws#DataResource';

describe('referent-type enrichment', () => {
  let pod;
  before(async (t) => { pod = await startLwsPod(t, 'alice'); });

  it('indexes the body subject rdf:type with NO rel=type header', async () => {
    // PUT JSON-LD whose subject #it declares @type = ex:Thing, no Link: rel=type
    const url = `${pod.base}/alice/m1`;
    const put = await request(url, { method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', Authorization: `Bearer ${pod.token}` },
      body: JSON.stringify({ '@id': `${pod.base}/alice/m1#it`, '@type': CONCEPT, 'http://purl.org/dc/terms/title': 'M1' }) });
    assert.ok([200, 201, 204].includes(put.status), `PUT ${put.status}`);

    // /types/search by the ex: type finds it
    const r = await request(`${pod.base}/types/search?type=${encodeURIComponent(CONCEPT)}`,
      { headers: { Authorization: `Bearer ${pod.token}` } });
    assert.equal(r.status, 200);
    const page = await r.json();
    const ids = page.items.map((i) => i.id);
    assert.ok(ids.some((id) => id.endsWith('/alice/m1')), 'referent type not indexed');
  });

  it('ENRICHES — lws#DataResource still matches the same resource', async () => {
    const r = await request(`${pod.base}/types/search?type=${encodeURIComponent(DATARES)}`,
      { headers: { Authorization: `Bearer ${pod.token}` } });
    const page = await r.json();
    assert.ok(page.items.map((i) => i.id).some((id) => id.endsWith('/alice/m1')),
      'enrich-not-replace violated: DataResource filter lost the resource');
  });

  it('SKIPS a multi-typed-subject aggregate (primary-referent-only rule)', async () => {
    const url = `${pod.base}/alice/agg`;
    await request(url, { method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', Authorization: `Bearer ${pod.token}` },
      body: JSON.stringify({ '@graph': [
        { '@id': `${pod.base}/alice/agg#a`, '@type': CONCEPT },
        { '@id': `${pod.base}/alice/agg#b`, '@type': CONCEPT } ] }) });
    const r = await request(`${pod.base}/types/search?type=${encodeURIComponent(CONCEPT)}`,
      { headers: { Authorization: `Bearer ${pod.token}` } });
    const page = await r.json();
    assert.ok(!page.items.map((i) => i.id).some((id) => id.endsWith('/alice/agg')),
      'aggregate with >1 typed subject should NOT be content-type-enriched');
  });
});

describe('referent-type enrichment: --lws OFF is unchanged', () => {
  let base, tok;
  before(async () => { await startTestServer({ lws: false }); base = getBaseUrl(); await createTestPod('bob'); tok = getPodToken('bob'); });
  after(stopTestServer);
  it('no .lwstypes enrichment without --lws', async () => {
    await fetch(`${base}/bob/x`, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ '@id': `${base}/bob/x#it`, '@type': CONCEPT }) });
    // No TypeSearchService without --lws; assert the write path didn't throw and the resource reads back.
    const g = await fetch(`${base}/bob/x`, { headers: { Authorization: `Bearer ${tok}` } });
    assert.ok([200, 406].includes(g.status));
  });
});
