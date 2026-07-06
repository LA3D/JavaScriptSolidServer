import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INDEXED_RELATIONS, parseFilter, matchesFilter } from '../src/lws/type-index.js';

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
