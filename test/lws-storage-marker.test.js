// test/lws-storage-marker.test.js
// Multi-tenant storage round, Task A1: every provisioned pod root is stamped
// with lws:Storage in its .lwstypes sidecar, so later storage-resolvers can
// find the tenant boundary without hardcoding pod-name conventions.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod } from './helpers.js';
import * as storage from '../src/storage/filesystem.js';
import { readDeclaredTypes, LWS_STORAGE } from '../src/lws/type-metadata.js';

describe('storage-root marker (lws:Storage in .lwstypes)', () => {
  let pod;
  before(async (t) => { pod = await startLwsPod(t, 'alice'); });

  it('a freshly provisioned named pod root carries lws:Storage', async () => {
    const types = await readDeclaredTypes(storage, `/${pod.podName}/`);
    assert.ok(types.includes(LWS_STORAGE), `expected lws:Storage in ${JSON.stringify(types)}`);
  });

  it('a freshly provisioned pod root records its owner (.lwsowner)', async () => {
    const { readOwners } = await import('../src/lws/type-metadata.js');
    assert.deepEqual(await readOwners(storage, `/${pod.podName}/`), [pod.webId]);
  });
});
