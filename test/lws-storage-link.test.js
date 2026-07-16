import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getAllHeaders } from '../src/ldp/headers.js';
import { storageDescriptionUrl } from '../src/lws/storage-description.js';
import { startTestServer, stopTestServer, request, createTestPod } from './helpers.js';

const REL = 'https://www.w3.org/ns/lws#storageDescription';
const R = 'http://localhost:3000/alice/note.ttl';

test('storageDescriptionUrl derives {origin}/.well-known/lws-storage', () => {
  assert.equal(storageDescriptionUrl(R), 'http://localhost:3000/.well-known/lws-storage');
});

test('storageDescriptionUrl throws a clear error on a relative URL', () => {
  assert.throws(
    () => storageDescriptionUrl('/alice/note.ttl'),
    { message: /requires an absolute URL/ }
  );
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

// Task A6 (multi-tenant round): storageDescription points at the OWNING
// storage's description, not the origin well-known, when a storageRootPath
// is threaded through from the request pipeline (storageRootFor, A2).
test('storageDescription rel points at the owning storage when storageRootPath given', () => {
  const h = getAllHeaders({ isContainer: false, origin: 'http://h', resourceUrl: 'http://h/alice/note.ttl', lwsEnabled: true, storageRootPath: '/alice/' });
  assert.match(h['Link'], /<http:\/\/h\/alice\/lws-storage>; rel="https:\/\/www\.w3\.org\/ns\/lws#storageDescription"/);
});

test('server-scope resource keeps the well-known target', () => {
  const h = getAllHeaders({ isContainer: false, origin: 'http://h', resourceUrl: 'http://h/robots.txt', lwsEnabled: true, storageRootPath: null });
  assert.match(h['Link'], /<http:\/\/h\/\.well-known\/lws-storage>/);
});

// HTTP-level: request.storageRootPath (server.js onRequest hook, A6) must
// actually resolve to the requester's OWN pod for a real GET, not just in
// the getAllHeaders unit above.
describe('lws: GET storageDescription rel targets the owning pod, not the well-known (A6)', () => {
  before(async () => {
    await startTestServer({ lws: true });
    await createTestPod('alice');
    await request('/alice/note.ttl', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      auth: 'alice',
      body: '<#it> a <http://example.org/Thing> .',
    });
  });
  after(stopTestServer);

  it('GET /alice/note.ttl storageDescription rel targets /alice/lws-storage', async () => {
    const res = await request('/alice/note.ttl', { auth: 'alice', headers: { Accept: 'text/turtle' } });
    const link = res.headers.get('link') || '';
    assert.match(link, new RegExp(`<[^>]*/alice/lws-storage>; rel="${REL}"`));
    assert.equal(link.includes('.well-known/lws-storage'), false,
      `Link should not point at the well-known target, got: ${link}`);
  });
});
