import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLwsWrite } from '../src/lws/write.js';

// Minimal in-memory storage double exposing the surface applyLwsWrite uses.
function fakeStorage(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async read(p) { if (!files.has(p)) throw new Error('nf'); return Buffer.from(files.get(p)); },
    async write(p, buf) { files.set(p, buf.toString('utf8')); return true; },
    async remove(p) { files.delete(p); return true; },
    async exists(p) { return files.has(p); },
  };
}

test('lwsEnabled=false: writes, no admission, no capture', async () => {
  const s = fakeStorage();
  const r = await applyLwsWrite({
    storage: s, storagePath: '/alice/x', resourceUrl: 'https://pod/alice/x',
    content: Buffer.from('{}'), contentType: 'application/ld+json',
    declaredTypes: [], lwsEnabled: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  assert.equal(s.files.get('/alice/x'), '{}');
});

test('lwsEnabled, no constraint declared: admits and writes', async () => {
  const s = fakeStorage();
  const r = await applyLwsWrite({
    storage: s, storagePath: '/alice/y', resourceUrl: 'https://pod/alice/y',
    content: Buffer.from('{}'), contentType: 'application/ld+json',
    declaredTypes: [], lwsEnabled: true,
  });
  assert.equal(r.ok, true);
  assert.equal(s.files.get('/alice/y'), '{}');
});

test('declaredTypes captured to sidecar; empty clears it', async () => {
  const s = fakeStorage();
  await applyLwsWrite({
    storage: s, storagePath: '/alice/z', resourceUrl: 'https://pod/alice/z',
    content: Buffer.from('{}'), contentType: 'application/ld+json',
    declaredTypes: ['https://ex/Note'], lwsEnabled: true,
  });
  assert.ok(s.files.has('/alice/z.lwstypes'), 'sidecar written');
  await applyLwsWrite({
    storage: s, storagePath: '/alice/z', resourceUrl: 'https://pod/alice/z',
    content: Buffer.from('{}'), contentType: 'application/ld+json',
    declaredTypes: [], lwsEnabled: true,
  });
  assert.equal(s.files.has('/alice/z.lwstypes'), false, 'sidecar cleared');
});
