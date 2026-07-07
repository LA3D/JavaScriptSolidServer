import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negotiateProfile } from '../src/rdf/conneg.js';

const RES = 'https://pod.example/alice/mem-a';
const reps = {
  default: { href: RES, format: 'text/markdown', profile: 'https://p/content' },
  alternates: [{ href: RES + '.links.jsonld', format: 'application/ld+json', profile: 'https://p/links' }],
};

test('no Accept-Profile → none', () => {
  assert.equal(negotiateProfile('', reps).outcome, 'none');
});
test('matches self default profile → self', () => {
  const r = negotiateProfile('<https://p/content>', reps);
  assert.equal(r.outcome, 'self');
  assert.equal(r.rep.href, RES);
});
test('matches a distinct alternate → redirect', () => {
  const r = negotiateProfile('<https://p/links>', reps);
  assert.equal(r.outcome, 'redirect');
  assert.equal(r.rep.href, RES + '.links.jsonld');
});
test('no match → notacceptable', () => {
  assert.equal(negotiateProfile('<https://p/nope>', reps).outcome, 'notacceptable');
});
