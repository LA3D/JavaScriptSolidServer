import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTypeFilter, matchesTypeFilter, isAbsoluteUri, FilterError } from '../src/lws/type-index.js';

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
