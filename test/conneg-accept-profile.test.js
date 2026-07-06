import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcceptProfile } from '../src/rdf/conneg.js';

test('parseAcceptProfile: empty/absent → []', () => {
  assert.deepEqual(parseAcceptProfile(''), []);
  assert.deepEqual(parseAcceptProfile(undefined), []);
});

test('parseAcceptProfile: single bracketed URI', () => {
  assert.deepEqual(parseAcceptProfile('<https://ex.org/p/x>'), ['https://ex.org/p/x']);
});

test('parseAcceptProfile: multiple, ordered by q desc, stable ties', () => {
  assert.deepEqual(
    parseAcceptProfile('<https://ex.org/p/x>;q=0.6, <https://ex.org/p/y>;q=1.0'),
    ['https://ex.org/p/y', 'https://ex.org/p/x']
  );
});
