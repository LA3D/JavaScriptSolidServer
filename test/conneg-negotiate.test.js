import { test } from 'node:test';
import assert from 'node:assert/strict';
import { negotiateProfile, getVaryHeader } from '../src/rdf/conneg.js';

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

// Final-review fix 2: Accept-Profile must only be advertised once profile
// conneg can actually engage (requires --lws). A --conneg-only pod (--lws
// off) never negotiates profiles, so the token must be absent there to keep
// the --lws-off path byte-identical.
test('getVaryHeader: conneg-only, --lws off → no Accept-Profile, has Accept/Authorization/Origin', () => {
  const vary = getVaryHeader(true, false, false);
  assert.ok(!vary.includes('Accept-Profile'), `expected no Accept-Profile, got: ${vary}`);
  assert.match(vary, /\bAccept\b/);
  assert.match(vary, /\bAuthorization\b/);
  assert.match(vary, /\bOrigin\b/);
});
test('getVaryHeader: --lws on → includes Accept-Profile', () => {
  const vary = getVaryHeader(false, false, true);
  assert.match(vary, /Accept-Profile/);
});
test('getVaryHeader: all off → Authorization, Origin only (no Accept)', () => {
  const vary = getVaryHeader(false, false, false);
  assert.equal(vary, 'Authorization, Origin');
});

test('alternate whose href collides with the default NEVER yields self', () => {
  // blank-node/self-authored alternates must not serve the default's bytes
  // under the alternate's profile (mis-stamp hazard) — always redirect.
  const collided = {
    default: { href: RES, format: 'text/markdown', profile: 'https://p/content' },
    alternates: [{ href: RES, format: 'application/ld+json', profile: 'https://p/links' }],
  };
  const r = negotiateProfile('<https://p/links>', collided);
  assert.equal(r.outcome, 'redirect');
  assert.equal(r.rep.profile, 'https://p/links');
});

test('default and an alternate declaring the SAME profile → default wins (self)', () => {
  const dup = {
    default: { href: RES, format: 'text/markdown', profile: 'https://p/content' },
    alternates: [{ href: RES + '.alt', format: 'text/markdown', profile: 'https://p/content' }],
  };
  assert.equal(negotiateProfile('<https://p/content>', dup).outcome, 'self');
});
