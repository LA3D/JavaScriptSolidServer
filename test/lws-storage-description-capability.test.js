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
