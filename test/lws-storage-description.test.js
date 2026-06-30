import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateStorageDescription } from '../src/lws/storage-description.js';

const ROOT = 'http://localhost:3000/';
const DESC = 'http://localhost:3000/.well-known/lws-storage';

test('storage description: required top-level shape', () => {
  const d = generateStorageDescription(ROOT, [
    { type: 'StorageDescription', serviceEndpoint: DESC },
  ]);
  assert.equal(d['@context'], 'https://www.w3.org/ns/lws/v1');
  assert.equal(d.id, ROOT);
  assert.equal(d.type, 'Storage');
  assert.ok(Array.isArray(d.service));
});

test('storage description: every service has type + serviceEndpoint', () => {
  const d = generateStorageDescription(ROOT, [
    { type: 'StorageDescription', serviceEndpoint: DESC },
    { type: 'NotificationService', serviceEndpoint: ROOT + 'notification/api' },
  ]);
  for (const s of d.service) {
    assert.equal(typeof s.type, 'string');
    assert.equal(typeof s.serviceEndpoint, 'string');
  }
  assert.ok(d.service.some(s => s.type === 'StorageDescription' && s.serviceEndpoint === DESC));
  assert.ok(d.service.some(s => s.type === 'NotificationService'));
});
