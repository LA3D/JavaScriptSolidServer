// test/lwsowner-metadata.test.js
// Governance round (2026-07-22): .lwsowner sidecar primitives + the
// read-merge-write marker helper the boot backfill depends on.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod } from './helpers.js';
import * as storage from '../src/storage/filesystem.js';
import {
  ownerStorePath, readOwners, writeOwners, ensureDeclaredType,
  readDeclaredTypes, typeStorePath, LWS_STORAGE,
} from '../src/lws/type-metadata.js';

describe('.lwsowner primitives + marker merge', () => {
  let pod, root;
  before(async (t) => { pod = await startLwsPod(t, 'govmeta'); root = `/${pod.podName}/`; });

  it('writeOwners/readOwners round-trip, dedupe, URI-only', async () => {
    await writeOwners(storage, root, [pod.webId, pod.webId, 'not a uri']);
    assert.deepEqual(await readOwners(storage, root), [pod.webId]);
    assert.equal(ownerStorePath(root), `${root}.lwsowner`);
  });

  it('readOwners returns [] for missing/corrupt sidecars', async () => {
    assert.deepEqual(await readOwners(storage, '/nowhere/'), []);
    await storage.write(ownerStorePath(root), Buffer.from('{corrupt'));
    assert.deepEqual(await readOwners(storage, root), []);
    await writeOwners(storage, root, [pod.webId]);            // restore
  });

  it('ensureDeclaredType merges, never overwrites, idempotent', async () => {
    await storage.write(typeStorePath(root), Buffer.from(JSON.stringify(['https://example.org/Custom'])));
    assert.equal(await ensureDeclaredType(storage, root, LWS_STORAGE), true);
    const types = await readDeclaredTypes(storage, root);
    assert.ok(types.includes('https://example.org/Custom'));   // merge, not overwrite
    assert.ok(types.includes(LWS_STORAGE));
    assert.equal(await ensureDeclaredType(storage, root, LWS_STORAGE), false);  // idempotent
  });
});
