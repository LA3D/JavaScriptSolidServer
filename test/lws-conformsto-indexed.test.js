import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { INDEXED_RELATIONS, parseFilter, matchesFilter } from '../src/lws/type-index.js';
import { startTestServer, stopTestServer, getBaseUrl, createTestPod } from './helpers.js';

const DCT_CONFORMS = 'http://purl.org/dc/terms/conformsTo';

test('conformsTo is an indexed relation', () => {
  assert.ok(INDEXED_RELATIONS.has('conformsTo'));
});

test('parseFilter routes conformsTo into relations (not hasUnindexed)', () => {
  const q = new URLSearchParams({ conformsTo: 'https://profiles.example/links' });
  const f = parseFilter({ query: q });
  assert.equal(f.hasUnindexed, false);
  assert.deepEqual(f.relations.conformsTo, [['https://profiles.example/links']]);
});

test('matchesFilter: resource with the conformsTo target matches', () => {
  const f = parseFilter({ query: new URLSearchParams({ conformsTo: 'https://profiles.example/links' }) });
  const yes = { types: ['x'], relations: { conformsTo: ['https://profiles.example/links'] } };
  const no = { types: ['x'], relations: { conformsTo: ['https://profiles.example/other'] } };
  assert.equal(matchesFilter(yes, f), true);
  assert.equal(matchesFilter(no, f), false);
});

// Mirrors the "describedby indexed relation" integration block in
// test/lws-type-index.test.js — exercises the real glue this task added:
// RELATION_READERS -> conformsToTargets -> entry.relations.conformsTo,
// dispatched from collectAuthorizedResources and reached via /types/search.
describe('GET/POST /types/search — conformsTo indexed relation', () => {
  let base, token;
  before(async () => {
    await startTestServer({ lws: true });
    base = getBaseUrl();
    const p = await createTestPod('alice'); token = p.token;
    const auth = { Authorization: `Bearer ${token}` };
    const PROFILE = `${base}/alice/profiles/llm-wiki`;
    await fetch(`${base}/alice/profiles/llm-wiki`, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json', ...auth }, body: '{}' });
    await fetch(`${base}/alice/doc1`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
    await fetch(`${base}/alice/doc1.meta`, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json', ...auth },
      body: JSON.stringify({ '@id': `${base}/alice/doc1`, [DCT_CONFORMS]: { '@id': PROFILE } }) });
    await fetch(`${base}/alice/doc2`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...auth }, body: '{}' });
  });
  after(async () => { await stopTestServer(); });

  const ids = (page) => page.items.map((i) => i.id);
  const search = async (qs) => (await fetch(`${base}/types/search?${qs}`, { headers: { Authorization: `Bearer ${token}` } })).json();

  it('?conformsTo=<profile> returns the declaring resource, not the undeclared one', async () => {
    const page = await search(`conformsTo=${encodeURIComponent(`${base}/alice/profiles/llm-wiki`)}`);
    assert.ok(ids(page).some((u) => u.endsWith('/alice/doc1')));
    assert.ok(!ids(page).some((u) => u.endsWith('/alice/doc2')));
  });

  it('?conformsTo=<other-profile> returns nothing (empty, not error)', async () => {
    const r = await fetch(`${base}/types/search?conformsTo=${encodeURIComponent(`${base}/alice/profiles/nope`)}`,
      { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).items.length, 0);
  });

  it('POST equivalent of conformsTo filter matches GET', async () => {
    const profile = `${base}/alice/profiles/llm-wiki`;
    const post = await (await fetch(`${base}/types/search`, { method: 'POST',
      headers: { 'Content-Type': 'application/lws+json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ '@context': 'https://www.w3.org/ns/lws/v1', conformsTo: [profile] }) })).json();
    assert.ok(post.items.some((i) => i.id.endsWith('/alice/doc1')));
  });
});
