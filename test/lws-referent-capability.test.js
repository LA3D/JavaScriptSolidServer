// Referent-resolution capability advertisement (2026-07-13): parallel to the
// DX-PROF-CONNEG capability — a cold agent (and the MCP surface) discovers
// the pod dereferences minted subject-IRI names by 303 via a URI-typed
// entry in the storage description's `capability` array. Pure unit tests
// on buildStorageDescription — no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStorageDescription } from '../src/lws/storage-description.js';
import { uriSpacePrefixesFor, resolveReferent } from '../src/lws/referent-resolver.js';

const CAP = 'https://w3id.org/lws-pod/capability/ReferentResolution';

test('advertises the referent-resolution capability when enabled', () => {
  const sd = buildStorageDescription('https://pod.example', { referentResolutionEnabled: true });
  assert.ok((sd.capability || []).some((c) => c.type === CAP), 'capability missing');
});
test('absent when disabled; default path unchanged', () => {
  const sd = buildStorageDescription('https://pod.example', {});
  assert.ok(!(sd.capability || []).some((c) => c.type === CAP));
  assert.ok(!('capability' in sd), 'capability key must be absent, not an empty array');
});
test('coexists with the profile-conneg capability', () => {
  const sd = buildStorageDescription('https://pod.example', { profileConnegEnabled: true, referentResolutionEnabled: true });
  const types = (sd.capability || []).map((c) => c.type);
  assert.ok(types.includes('http://www.w3.org/ns/dx/connegp/profile/http'));
  assert.ok(types.includes(CAP));
});

// Task 10 (2026-07-14): structured recognition prefixes on the capability —
// closes probe #2 (a cold agent should recognize a minted subject-IRI name on
// its FIRST read of the storage description, not confirm the prefix from the
// VoID document two hops later).
test('the ReferentResolution capability carries structured uriSpace prefixes', () => {
  const origin = 'https://pod.example';
  const sd = buildStorageDescription(origin, { referentResolutionEnabled: true, uriSpacePrefixes: [`${origin}/id/`] });
  const cap = sd.capability.find((c) => c.type === CAP);
  assert.ok(Array.isArray(cap.uriSpace), 'uriSpace is an array');
  assert.ok(cap.uriSpace.some((u) => u.endsWith('/id/')), 'uriSpace names the minted prefix');
});
test('uriSpacePrefixes absent/empty leaves the capability byte-identical to today (no uriSpace key)', () => {
  const sd1 = buildStorageDescription('https://pod.example', { referentResolutionEnabled: true });
  const cap1 = sd1.capability.find((c) => c.type === CAP);
  assert.ok(!('uriSpace' in cap1), 'no uriSpace key when uriSpacePrefixes absent');

  const sd2 = buildStorageDescription('https://pod.example', { referentResolutionEnabled: true, uriSpacePrefixes: [] });
  const cap2 = sd2.capability.find((c) => c.type === CAP);
  assert.ok(!('uriSpace' in cap2), 'no uriSpace key when uriSpacePrefixes empty');
});

// T10 (whole-branch review, 2026-07-14): the prefix filter (shared by both
// surfaces via uriSpacePrefixesFor) must mirror resolveReferent's FULL guard.
// resolveReferent skips an entry with no `container` (:13 `!container`), so a
// pathPrefix-only entry would be advertised on the capability yet never
// 303-resolve. The filter now also requires a string container.
test('T10: a uriSpace entry with pathPrefix but no container is NOT advertised', () => {
  const origin = 'https://pod.example';
  const out = uriSpacePrefixesFor([
    { pathPrefix: '/id/', container: '/cards/' },   // resolvable  -> advertised
    { pathPrefix: '/broken/' },                     // no container -> skipped
    { pathPrefix: '/x/', container: 123 },          // non-string container -> skipped
    { pathPrefix: 'no-slash/', container: '/c/' },  // pathPrefix without leading context still fine
    { pathPrefix: 'noslash', container: '/c/' },    // no trailing slash -> skipped
  ], origin);
  assert.deepEqual(out, [`${origin}/id/`, `${origin}/no-slash/`]);
});

test('T10: advertised prefixes are exactly the ones resolveReferent can 303-resolve', () => {
  const spaces = [
    { pathPrefix: '/id/', container: '/cards/', suffix: '.md' },
    { pathPrefix: '/broken/' },                     // no container
  ];
  const advertised = uriSpacePrefixesFor(spaces, 'https://pod.example');
  assert.deepEqual(advertised, ['https://pod.example/id/']);
  // parity with the resolver: the advertised one resolves, the skipped one never does
  assert.ok(resolveReferent('/id/alice', spaces), 'advertised prefix must resolve');
  assert.equal(resolveReferent('/broken/alice', spaces), null, 'un-advertised prefix must not resolve');
});
