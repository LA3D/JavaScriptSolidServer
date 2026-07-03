import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, postMcp, ownerBearer, putFile } from './helpers.js';

async function read(pod, uri, token) {
  const { body } = await postMcp(pod,
    { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } },
    token ? { Authorization: `Bearer ${token}` } : {});
  return body;
}

test('lws://storage-description returns a type:Storage doc', async (t) => {
  const pod = await startLwsPod(t);
  const body = await read(pod, 'lws://storage-description', ownerBearer(pod));
  const sd = JSON.parse(body.result.contents[0].text);
  assert.equal(sd.type, 'Storage');
  assert.ok((sd.service || []).some(s => s.type === 'TypeSearchService'));
});

test('lws://skill reads a skill file; anonymous read of a private skill is denied', async (t) => {
  const pod = await startLwsPod(t);
  const token = ownerBearer(pod);
  await putFile(pod, `/${pod.podName}/bot/SKILL.md`, '# bot skill'); // owner-private

  const anon = await read(pod, `lws://skill/${pod.podName}/bot/SKILL.md`);
  assert.ok(anon.error);
  assert.match(anon.error.message, /access denied/i);

  const owner = await read(pod, `lws://skill/${pod.podName}/bot/SKILL.md`, token);
  assert.match(owner.result.contents[0].text, /bot skill/);
});

test('lws://skills returns a WAC-filtered index', async (t) => {
  const pod = await startLwsPod(t);
  const body = await read(pod, 'lws://skills', ownerBearer(pod));
  const idx = JSON.parse(body.result.contents[0].text);
  assert.ok(Array.isArray(idx['skill:items']));
});
