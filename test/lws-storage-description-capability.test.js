import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStorageDescription } from '../src/lws/storage-description.js';

test('capability[] advertises ContentNegotiation when profileConnegEnabled', () => {
  const sd = buildStorageDescription('https://pod.example', { profileConnegEnabled: true });
  assert.ok(Array.isArray(sd.capability));
  const cn = sd.capability.find((c) => /ContentNegotiation/.test(c.type) || /connegp\/profile\/http/.test(c.type));
  assert.ok(cn, 'a content-negotiation-by-profile capability is present');
});

test('no capability[] when disabled', () => {
  const sd = buildStorageDescription('https://pod.example', {});
  assert.equal('capability' in sd, false);
});
