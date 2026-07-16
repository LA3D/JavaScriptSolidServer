import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storageRootFor, clearStorageRootCache } from '../src/lws/storage-resolver.js';
import { LWS_STORAGE } from '../src/lws/type-metadata.js';

// minimal fake storage: only /alice/ carries the marker
function fakeStorage(marked = new Set(['/alice/'])) {
  return {
    async exists(p) { return marked.has(p.replace(/\.lwstypes$/, '')) && p.endsWith('.lwstypes'); },
    async read(p) {
      const root = p.replace(/\.lwstypes$/, '');
      return marked.has(root) ? Buffer.from(JSON.stringify([LWS_STORAGE])) : null;
    },
  };
}

test('resolves a resource under a marked pod to its storage root', async () => {
  clearStorageRootCache();
  assert.equal(await storageRootFor(fakeStorage(), '/alice/notes/x.ttl'), '/alice/');
  assert.equal(await storageRootFor(fakeStorage(), '/alice/'), '/alice/');
});

test('server-scope paths resolve to null', async () => {
  clearStorageRootCache();
  const s = fakeStorage();
  assert.equal(await storageRootFor(s, '/'), null);
  assert.equal(await storageRootFor(s, '/.well-known/lws-storage'), null);
  assert.equal(await storageRootFor(s, '/types/index'), null);   // first seg 'types' has no marker
});

test('an unmarked first segment resolves to null (not every path is a pod)', async () => {
  clearStorageRootCache();
  assert.equal(await storageRootFor(fakeStorage(), '/bob/x'), null); // /bob/ not marked here
});

test('a negative result is NOT cached (pod provisioned after a first miss resolves)', async () => {
  clearStorageRootCache();
  const marked = new Set();               // /bob/ not yet a storage
  const s = fakeStorage(marked);
  assert.equal(await storageRootFor(s, '/bob/x'), null);    // miss
  marked.add('/bob/');                     // pod provisioned
  assert.equal(await storageRootFor(s, '/bob/x'), '/bob/'); // resolves now (negative was not cached)
});
