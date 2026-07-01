import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTypeFilter, matchesTypeFilter, isAbsoluteUri, FilterError, intrinsicType, resourceTypes, buildTypeIndex, containerItemTypes, MAX_GROUPS, MAX_VALUES_PER_GROUP, MAX_TOTAL_TERMS } from '../src/lws/type-index.js';

const A = 'https://schema.org/Person';
const B = 'http://xmlns.com/foaf/0.1/Person';
const C = 'https://www.w3.org/ns/lws#DataResource';

describe('CNF type filter', () => {
  it('GET query: comma = OR group, repeated param = AND', () => {
    const q = new URLSearchParams(`type=${A},${B}&type=${C}`);
    assert.deepEqual(parseTypeFilter({ query: q }), [[A, B], [C]]);
  });
  it('POST body: array element = AND, nested array = OR', () => {
    assert.deepEqual(parseTypeFilter({ body: { type: [[A, B], C] } }), [[A, B], [C]]);
  });
  it('no type param → empty CNF (matches everything)', () => {
    assert.deepEqual(parseTypeFilter({ query: new URLSearchParams('') }), []);
    assert.equal(matchesTypeFilter([C], []), true);
  });
  it('matches (A OR B) AND C', () => {
    assert.equal(matchesTypeFilter([A, C], [[A, B], [C]]), true);
    assert.equal(matchesTypeFilter([A], [[A, B], [C]]), false); // missing C group
    assert.equal(matchesTypeFilter([B, C], [[A, B], [C]]), true);
  });
  it('rejects a non-absolute-URI type value with a 400 FilterError', () => {
    assert.throws(() => parseTypeFilter({ query: new URLSearchParams('type=notauri') }),
      (e) => e instanceof FilterError && e.status === 400);
  });
  it('rejects a non-string type value in nested array with a 400 FilterError', () => {
    assert.throws(() => parseTypeFilter({ body: { type: [[A, 5]] } }),
      (e) => e instanceof FilterError && e.status === 400);
  });
  it('empty/duplicate groups are ignored, not errors', () => {
    const q = new URLSearchParams(`type=${A},,${A}`);
    assert.deepEqual(parseTypeFilter({ query: q }), [[A]]);
  });
  it('isAbsoluteUri', () => {
    assert.equal(isAbsoluteUri(A), true);
    assert.equal(isAbsoluteUri('relative/path'), false);
  });
});

describe('type resolution + index', () => {
  it('intrinsicType', () => {
    assert.equal(intrinsicType(true), 'https://www.w3.org/ns/lws#Container');
    assert.equal(intrinsicType(false), 'https://www.w3.org/ns/lws#DataResource');
  });
  it('resourceTypes = intrinsic ∪ declared, deduped, intrinsic first', () => {
    assert.deepEqual(
      resourceTypes({ isDirectory: false, declared: ['https://schema.org/Person'] }),
      ['https://www.w3.org/ns/lws#DataResource', 'https://schema.org/Person']);
    assert.deepEqual(
      resourceTypes({ isDirectory: false, declared: ['https://www.w3.org/ns/lws#DataResource'] }),
      ['https://www.w3.org/ns/lws#DataResource']); // dedupe intrinsic
  });
  it('buildTypeIndex returns distinct types with count', () => {
    const idx = buildTypeIndex([
      ['https://www.w3.org/ns/lws#DataResource', 'https://schema.org/Person'],
      ['https://www.w3.org/ns/lws#DataResource'],
    ]);
    assert.equal(idx.type, 'TypeIndex');
    assert.equal(idx['@context'], 'https://www.w3.org/ns/lws/v1');
    assert.equal(idx.totalItems, 2);
    assert.deepEqual(idx.items.map((i) => i.id).sort(),
      ['https://schema.org/Person', 'https://www.w3.org/ns/lws#DataResource']);
  });
  it('containerItemTypes: intrinsic Container compacted', () => {
    assert.deepEqual(containerItemTypes(['https://www.w3.org/ns/lws#Container']), ['Container']);
  });
  it('containerItemTypes: intrinsic DataResource + user type, order preserved', () => {
    assert.deepEqual(
      containerItemTypes(['https://www.w3.org/ns/lws#DataResource', 'https://schema.org/Person']),
      ['DataResource', 'https://schema.org/Person']);
  });
  it('containerItemTypes: unknown-only types are left unchanged', () => {
    assert.deepEqual(
      containerItemTypes(['https://schema.org/Person', 'http://ex/Note']),
      ['https://schema.org/Person', 'http://ex/Note']);
  });
});

describe('CNF complexity caps', () => {
  const uri = (n) => `https://ex.org/T${n}`;
  it('rejects too many groups with 400', () => {
    const q = new URLSearchParams();
    for (let i = 0; i <= MAX_GROUPS; i++) q.append('type', uri(i));
    assert.throws(() => parseTypeFilter({ query: q }), (e) => e instanceof FilterError && e.status === 400);
  });
  it('rejects too many values in one group with 400', () => {
    const g = Array.from({ length: MAX_VALUES_PER_GROUP + 1 }, (_, i) => uri(i)).join(',');
    const q = new URLSearchParams(); q.append('type', g);
    assert.throws(() => parseTypeFilter({ query: q }), (e) => e instanceof FilterError && e.status === 400);
  });
  it('rejects too many total terms with 400', () => {
    // groups within MAX_GROUPS but total terms over MAX_TOTAL_TERMS
    const per = Math.ceil((MAX_TOTAL_TERMS + 1) / MAX_GROUPS);
    const q = new URLSearchParams();
    for (let g = 0; g < MAX_GROUPS; g++)
      q.append('type', Array.from({ length: per }, (_, i) => uri(g * 100 + i)).join(','));
    assert.throws(() => parseTypeFilter({ query: q }), (e) => e instanceof FilterError && e.status === 400);
  });
  it('accepts a filter just under the bounds', () => {
    const q = new URLSearchParams();
    for (let i = 0; i < MAX_GROUPS; i++) q.append('type', uri(i));
    assert.equal(parseTypeFilter({ query: q }).length, MAX_GROUPS);
  });
  it('rejects single group padded with duplicates exceeding MAX_VALUES_PER_GROUP', () => {
    // Raw count check: many copies of the same URI exceed the per-group cap, even though dedup → 1
    const dup = 'https://ex.org/Dup';
    const rawValues = Array.from({ length: MAX_VALUES_PER_GROUP + 5 }, () => dup);
    const q = new URLSearchParams(); q.append('type', rawValues.join(','));
    assert.throws(() => parseTypeFilter({ query: q }), (e) => e instanceof FilterError && e.status === 400);
  });
  it('rejects multiple groups where each exceeds MAX_VALUES_PER_GROUP with per-group duplicates', () => {
    // Each group: many URIs padded with internal duplication, such that deduped total stays low
    // but RAW per-group cap is exceeded (demonstrating dedup-evasion protection)
    const q = new URLSearchParams();
    for (let g = 0; g < 5; g++) {
      // Each group has 3 unique URIs, but each padded by repetition to exceed the per-group raw cap
      const rawValues = [];
      for (let u = 0; u < 3; u++) {
        const uniqueUri = `https://ex.org/G${g}U${u}`;
        // Repeat each unique URI enough times so the raw count exceeds MAX_VALUES_PER_GROUP / 3
        for (let rep = 0; rep < Math.ceil((MAX_VALUES_PER_GROUP + 2) / 3); rep++) {
          rawValues.push(uniqueUri);
        }
      }
      // rawValues.length will exceed MAX_VALUES_PER_GROUP per group
      q.append('type', rawValues.join(','));
    }
    assert.throws(() => parseTypeFilter({ query: q }), (e) => e instanceof FilterError && e.status === 400);
  });
});
