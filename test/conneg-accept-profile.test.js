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

test('R13: q=0 entry is discarded (RFC 9110 §12.5.1 "not acceptable")', () => {
  assert.deepEqual(parseAcceptProfile('<https://p/a>;q=0, <https://p/b>;q=0.5'), ['https://p/b']);
});

test('R13: all-q=0 header yields empty list (degrades to outcome none)', () => {
  assert.deepEqual(parseAcceptProfile('<https://p/a>;q=0'), []);
});

test('R13: out-of-range q clamps into [0,1] — q=2 no longer outranks q=1', () => {
  assert.deepEqual(parseAcceptProfile('<https://p/a>;q=2, <https://p/b>'), ['https://p/a', 'https://p/b']);
  // clamped to 1.0 each; stable input order breaks the tie — b would LOSE its
  // rightful tie if 2.0 were kept (it used to sort strictly above q=1)
  assert.deepEqual(parseAcceptProfile('<https://p/a>, <https://p/b>;q=2'), ['https://p/a', 'https://p/b']);
});

test('R13: negative q clamps to 0 and is discarded', () => {
  assert.deepEqual(parseAcceptProfile('<https://p/a>;q=-1, <https://p/b>'), ['https://p/b']);
});

test('R13: non-numeric q stays 1.0 (unchanged behavior, now pinned)', () => {
  assert.deepEqual(parseAcceptProfile('<https://p/a>;q=abc, <https://p/b>;q=0.5'), ['https://p/a', 'https://p/b']);
});
