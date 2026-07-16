import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePodConfigResolver } from '../src/lws/pod-config.js';

function fakeStorage(files) {
  return {
    async exists(p) { return p in files; },
    async read(p) { return p in files ? Buffer.from(files[p]) : null; },
    async stat(p) { return { mtimeMs: 1, size: (files[p] || '').length }; },
  };
}

test('resolves each storage to its own config file', async () => {
  const files = {
    '/alice/profiles/pod-config.jsonld': JSON.stringify({ uriSpaces: [{ pathPrefix: '/alice/id/', container: '/alice/wiki/' }] }),
    '/bob/profiles/pod-config.jsonld':   JSON.stringify({ uriSpaces: [{ pathPrefix: '/bob/id/',   container: '/bob/wiki/' }] }),
  };
  const resolver = makePodConfigResolver(fakeStorage(files), 'profiles/pod-config.jsonld');
  const alice = await resolver.for('/alice/').get();
  const bob = await resolver.for('/bob/').get();
  assert.equal(alice.uriSpaces[0].pathPrefix, '/alice/id/');
  assert.equal(bob.uriSpaces[0].pathPrefix, '/bob/id/');
});

test('server scope (null root) returns empty config', async () => {
  const resolver = makePodConfigResolver(fakeStorage({}), 'profiles/pod-config.jsonld');
  assert.deepEqual(await resolver.for(null).get(), {});
});
