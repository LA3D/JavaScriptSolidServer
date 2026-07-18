// R6 (matrix 2026-07-18): root-pod deployments — the '/' marker is written by
// createRootPodStructure but storageRootFor never read it, so root-pod resources
// pointed their storageDescription at the (empty) ServerIndex and referent 303s
// were dead. Fallback: named-pod candidate first (unchanged), then '/'.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import { createServer } from '../src/server.js';
import { storageRootFor, clearStorageRootCache } from '../src/lws/storage-resolver.js';

// Minimal storage stub adapted to readDeclaredTypes' real calls: it reads
// `${root}.lwstypes` via storage.exists() + storage.read() and JSON.parses the
// buffer as a PLAIN type-URI array (not an object) — see src/lws/type-metadata.js.
function fakeStorage(markedRoots) {
  const marks = new Set(markedRoots.map((r) => `${r}.lwstypes`));
  return {
    exists: async (p) => marks.has(p),
    read: async (p) => (marks.has(p)
      ? Buffer.from(JSON.stringify(['https://www.w3.org/ns/lws#Storage']))
      : null),
  };
}

test('named-pod candidate still wins (unchanged behavior)', async () => {
  clearStorageRootCache();
  assert.equal(await storageRootFor(fakeStorage(['/alice/']), '/alice/notes/a.md'), '/alice/');
});

test('root-marked storage resolves any path to /', async () => {
  clearStorageRootCache();
  const s = fakeStorage(['/']);
  assert.equal(await storageRootFor(s, '/notes/a.md'), '/');
  assert.equal(await storageRootFor(s, '/'), '/');
});

test('unmarked stays null (named-pod rig unchanged)', async () => {
  clearStorageRootCache();
  assert.equal(await storageRootFor(fakeStorage(['/alice/']), '/stray.md'), null);
  assert.equal(await storageRootFor(fakeStorage(['/alice/']), '/'), null);
});

test('.well-known stays server-scope even when / is marked', async () => {
  clearStorageRootCache();
  assert.equal(await storageRootFor(fakeStorage(['/']), '/.well-known/lws-storage'), null);
});

// ---- Wire tests. `storage` (src/storage/filesystem.js) is a process-global
// singleton keyed on process.env.DATA_ROOT, and the _isRoot cache is likewise
// process-global — so the two servers below CANNOT run at once. Each block
// boots its own root, tears it down, and clears the marker cache so a '/'
// positive never leaks between blocks (a test-only concern: one prod process
// serves one data root).
const ROOT_DIR = './test-data-lws-root-pod';
const NAMED_DIR = './test-data-lws-root-pod-named';

describe('R6 root-pod wire', () => {
  let server, baseUrl, savedDataRoot;
  before(async () => {
    clearStorageRootCache();
    savedDataRoot = process.env.DATA_ROOT;
    await fs.remove(ROOT_DIR);
    await fs.ensureDir(ROOT_DIR);
    server = createServer({ logger: false, lws: true, singleUser: true, root: ROOT_DIR, forceCloseConnections: true });
    await server.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${server.server.address().port}`;
  });
  after(async () => {
    await server.close();
    await fs.remove(ROOT_DIR);
    clearStorageRootCache();
    if (savedDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = savedDataRoot;
  });

  test('root-pod: resource Link points at /lws-storage; route serves the description', async () => {
    // A public data resource (createRootPodStructure seeds /profile/ public-read)
    // exercises resource.js getAllHeaders, which stamps the storageDescription Link.
    const r = await fetch(`${baseUrl}/profile/card.jsonld`);
    assert.equal(r.status, 200);
    // origin-root form (`{origin}/lws-storage`), NOT the well-known ServerIndex —
    // the whole point of R6 is that root-pod resources stop pointing at the empty index.
    assert.match(r.headers.get('link'), /<https?:\/\/[^/]+\/lws-storage>; rel="https:\/\/www\.w3\.org\/ns\/lws#storageDescription"/);

    const sd = await fetch(`${baseUrl}/lws-storage`, { headers: { Accept: 'application/lws+json' } });
    assert.equal(sd.status, 200);
    const body = await sd.json();
    assert.equal(body.type, 'Storage');
    assert.ok(sd.headers.get('etag'));           // R3 applies here too (sendJsonWithEtag)
  });

  test('root-pod: / appears in the ServerIndex roster', async () => {
    const idx = await fetch(`${baseUrl}/.well-known/lws-storage`, { headers: { Accept: 'application/lws+json' } });
    assert.equal(idx.status, 200);
    const body = await idx.json();
    assert.equal(body.type, 'ServerIndex');
    // the root storage self-describes at {origin}/lws-storage
    const descs = (body.storage || []).map((s) => s.storageDescription || '');
    assert.ok(descs.some((d) => d.endsWith('/lws-storage') && !d.includes('.well-known')),
      `expected the root storage in the roster, got ${JSON.stringify(body.storage)}`);
  });
});

describe('R6 named-pod negative control', () => {
  let server, baseUrl, savedDataRoot;
  before(async () => {
    clearStorageRootCache();
    savedDataRoot = process.env.DATA_ROOT;
    await fs.remove(NAMED_DIR);
    await fs.ensureDir(NAMED_DIR);
    server = createServer({ logger: false, lws: true, singleUser: true, singleUserName: 'alice', root: NAMED_DIR, forceCloseConnections: true });
    await server.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${server.server.address().port}`;
  });
  after(async () => {
    await server.close();
    await fs.remove(NAMED_DIR);
    clearStorageRootCache();
    if (savedDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = savedDataRoot;
  });

  test('named-pod mode: GET /lws-storage falls through to LDP (no shadowing)', async () => {
    // on a NAMED-pod server (/ unmarked): /lws-storage is an ordinary resource
    // path, never the root storage description.
    const r = await fetch(`${baseUrl}/lws-storage`);
    assert.notEqual(r.headers.get('content-type'), 'application/lws+json');
  });
});
