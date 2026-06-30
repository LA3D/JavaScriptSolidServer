import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAllHeaders } from '../src/ldp/headers.js';
import { storageDescriptionUrl } from '../src/lws/storage-description.js';

const REL = 'https://www.w3.org/ns/lws#storageDescription';
const R = 'http://localhost:3000/alice/note.ttl';

test('storageDescriptionUrl derives {origin}/.well-known/lws-storage', () => {
  assert.equal(storageDescriptionUrl(R), 'http://localhost:3000/.well-known/lws-storage');
});

test('storageDescription rel present when lwsEnabled + resourceUrl', () => {
  const h = getAllHeaders({
    isContainer: false, etag: '"x"', contentType: 'text/turtle',
    origin: 'http://localhost:3000', resourceUrl: R, lwsEnabled: true,
  });
  assert.match(h['Link'], new RegExp(`<http://localhost:3000/\\.well-known/lws-storage>; rel="${REL}"`));
});

test('storageDescription rel ABSENT when lwsEnabled is false', () => {
  const h = getAllHeaders({
    isContainer: false, etag: '"x"', contentType: 'text/turtle',
    origin: 'http://localhost:3000', resourceUrl: R, lwsEnabled: false,
  });
  assert.equal((h['Link'] || '').includes('storageDescription'), false);
});

test('linkset rel present when lwsEnabled + resourceUrl', () => {
  const h = getAllHeaders({
    isContainer: false, etag: '"x"', contentType: 'text/turtle',
    origin: 'http://localhost:3000', resourceUrl: R, lwsEnabled: true,
  });
  assert.match(h['Link'], /rel="linkset"/);
  assert.match(h['Link'], /type="application\/linkset\+json"/);
});

test('storageDescription and linkset both present when lwsEnabled', () => {
  const h = getAllHeaders({
    isContainer: false, etag: '"x"', contentType: 'text/turtle',
    origin: 'http://localhost:3000', resourceUrl: R, lwsEnabled: true,
  });
  assert.match(h['Link'], new RegExp(`rel="${REL}"`));
  assert.match(h['Link'], /rel="linkset"/);
});

test('linkset rel ABSENT when lwsEnabled is false', () => {
  const h = getAllHeaders({
    isContainer: false, etag: '"x"', contentType: 'text/turtle',
    origin: 'http://localhost:3000', resourceUrl: R, lwsEnabled: false,
  });
  assert.equal((h['Link'] || '').includes('linkset'), false);
});
