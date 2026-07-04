import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStorageDescription } from '../src/lws/storage-description.js';

test('profileIndexPath adds ProfileIndexService; absent by default', () => {
  const on = buildStorageDescription('https://pod.example', { typeIndexEnabled: true, profileIndexPath: '/alice/profiles/index.jsonld' });
  const svc = on.service.find((s) => s.type === 'ProfileIndexService');
  assert.deepEqual(svc, { type: 'ProfileIndexService', serviceEndpoint: 'https://pod.example/alice/profiles/index.jsonld' });
  const off = buildStorageDescription('https://pod.example', { typeIndexEnabled: true });
  assert.equal(off.service.some((s) => s.type === 'ProfileIndexService'), false);
});
