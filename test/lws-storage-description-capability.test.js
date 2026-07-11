import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStorageDescription } from '../src/lws/storage-description.js';

test('capability[] advertises ContentNegotiation when profileConnegEnabled', () => {
  const sd = buildStorageDescription('https://pod.example', { profileConnegEnabled: true });
  assert.ok(Array.isArray(sd.capability));
  assert.equal(sd.capability[0].type, 'http://www.w3.org/ns/dx/connegp/profile/http');
});

test('no capability[] when disabled', () => {
  const sd = buildStorageDescription('https://pod.example', {});
  assert.equal('capability' in sd, false);
});

test('storage-description linkset hint: no over-promise + membership steering', () => {
  const sd = buildStorageDescription('https://pod.example', {});
  const hint = sd.linkset.hint;
  assert.ok(!hint.includes('every resource serves'));                    // the over-promise is gone
  assert.match(hint, /shadowed by its index\.html/);                     // the shadowed-container caveat
  assert.match(hint, /ldp:contains/);                                    // membership steering
  assert.match(hint, /items\[\]/);
  assert.match(hint, /TypeSearchService/);
  assert.match(hint, /CONTAINER's linkset/);                             // the load-bearing governance sentence survives
});
