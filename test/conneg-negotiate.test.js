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

const dupReps = {
  default: { href: RES, format: 'text/markdown', profile: 'https://p/shared' },
  alternates: [
    { href: RES + '.data.jsonld', format: 'application/ld+json', profile: 'https://p/shared' },
    { href: RES + '.page.html', format: 'text/html', profile: 'https://p/shared' },
  ],
};
test('R14: same profile on 3 reps, Accept text/html picks the html alternate', () => {
  const r = negotiateProfile('<https://p/shared>', dupReps, 'text/html');
  assert.equal(r.outcome, 'redirect');
  assert.equal(r.rep.href, RES + '.page.html');
});
test('R14: Accept application/ld+json picks the jsonld alternate', () => {
  const r = negotiateProfile('<https://p/shared>', dupReps, 'application/ld+json');
  assert.equal(r.rep.href, RES + '.data.jsonld');
});
test('R14: no Accept → default slot wins the duplicate set', () => {
  const r = negotiateProfile('<https://p/shared>', dupReps, '');
  assert.equal(r.outcome, 'self');
});
test('R14: Accept matching nothing in the set → default slot (tie-break, not 406)', () => {
  const r = negotiateProfile('<https://p/shared>', dupReps, 'image/png');
  assert.equal(r.outcome, 'self');
});
test('R14: Accept q-order respected — html;q=0.1, ld+json;q=0.9 picks jsonld', () => {
  const r = negotiateProfile('<https://p/shared>', dupReps, 'text/html;q=0.1, application/ld+json;q=0.9');
  assert.equal(r.rep.href, RES + '.data.jsonld');
});
test('R14: Accept q=0 excludes a media type from disambiguation', () => {
  const r = negotiateProfile('<https://p/shared>', dupReps, 'text/html;q=0, application/ld+json');
  assert.equal(r.rep.href, RES + '.data.jsonld');
});
test('R14: single match ignores Accept entirely (unchanged fast path)', () => {
  const r = negotiateProfile('<https://p/links>', reps, 'text/html');
  assert.equal(r.rep.href, RES + '.links.jsonld');
});
test('R14: wildcard Accept */* picks first in declaration order (default first)', () => {
  const r = negotiateProfile('<https://p/shared>', dupReps, '*/*');
  assert.equal(r.outcome, 'self');
});
