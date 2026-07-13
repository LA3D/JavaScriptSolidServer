// Referent-resolution capability advertisement (2026-07-13): parallel to the
// DX-PROF-CONNEG capability — a cold agent (and the MCP surface) discovers
// the pod dereferences minted subject-IRI names by 303 via a URI-typed
// entry in the storage description's `capability` array. Pure unit tests
// on buildStorageDescription — no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStorageDescription } from '../src/lws/storage-description.js';

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
