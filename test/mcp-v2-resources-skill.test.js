import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, postMcp, ownerBearer, putFile } from './helpers.js';

async function read(pod, uri, token) {
  const { body } = await postMcp(pod,
    { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } },
    token ? { Authorization: `Bearer ${token}` } : {});
  return body;
}

// Multi-tenant round (Task A5, D5 -> A7 parity): the well-known is now a
// ServerIndex roster; following its storage[].storageDescription entry lands
// on the per-storage type:Storage doc a pre-multi-tenant client expected
// directly at the well-known.
test('/.well-known/lws-storage returns a ServerIndex; following storageDescription returns the type:Storage doc', async (t) => {
  const pod = await startLwsPod(t);
  const idxBody = await read(pod, `${pod.base}/.well-known/lws-storage`, ownerBearer(pod));
  const idx = JSON.parse(idxBody.result.contents[0].text);
  assert.equal(idx.type, 'ServerIndex');
  const entry = idx.storage.find(s => s.id.endsWith(`/${pod.podName}/`));
  assert.ok(entry, 'ServerIndex must list the pod storage');

  const sdBody = await read(pod, entry.storageDescription, ownerBearer(pod));
  const sd = JSON.parse(sdBody.result.contents[0].text);
  assert.equal(sd.type, 'Storage');
  assert.ok((sd.service || []).some(s => s.type === 'TypeSearchService'));
});

test('a skill file reads at its real URL; anonymous read of a private skill is denied', async (t) => {
  const pod = await startLwsPod(t);
  const token = ownerBearer(pod);
  await putFile(pod, `/${pod.podName}/bot/SKILL.md`, '# bot skill'); // owner-private

  const anon = await read(pod, `${pod.base}/${pod.podName}/bot/SKILL.md`);
  assert.ok(anon.error);
  assert.match(anon.error.message, /not found or not authorized/i);

  const owner = await read(pod, `${pod.base}/${pod.podName}/bot/SKILL.md`, token);
  assert.match(owner.result.contents[0].text, /bot skill/);
});

test('/.well-known/mcp/skills returns a WAC-filtered index', async (t) => {
  const pod = await startLwsPod(t);
  const body = await read(pod, `${pod.base}/.well-known/mcp/skills`, ownerBearer(pod));
  const idx = JSON.parse(body.result.contents[0].text);
  assert.ok(Array.isArray(idx['skill:items']));
});
