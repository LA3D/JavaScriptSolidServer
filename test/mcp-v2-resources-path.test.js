import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, postMcp, ownerBearer, seedTyped } from './helpers.js';

async function read(pod, uri, token) {
  const { body } = await postMcp(pod,
    { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } },
    token ? { Authorization: `Bearer ${token}` } : {});
  return body;
}

test('lws://resource returns a body; lws://linkset returns the typed linkset', async (t) => {
  const pod = await startLwsPod(t);
  const token = ownerBearer(pod);
  const url = await seedTyped(pod, `/${pod.podName}/notes/a`, 'http://ex/Note', { publicRead: true });
  assert.ok(url);

  const body = await read(pod, `lws://resource/${pod.podName}/notes/a`, token);
  assert.ok(body.result.contents[0].text.length > 0);

  const ls = await read(pod, `lws://linkset/${pod.podName}/notes/a`, token);
  assert.match(ls.result.contents[0].text, /http:\/\/ex\/Note/);
});

test('lws://container lists children; lws://meta returns size/modified', async (t) => {
  const pod = await startLwsPod(t);
  const token = ownerBearer(pod);
  await seedTyped(pod, `/${pod.podName}/notes/a`, 'http://ex/Note');

  const c = await read(pod, `lws://container/${pod.podName}/notes/`, token);
  const listing = JSON.parse(c.result.contents[0].text);
  assert.ok(listing.items.some(i => i.name === 'a'));

  const m = await read(pod, `lws://meta/${pod.podName}/notes/a`, token);
  const meta = JSON.parse(m.result.contents[0].text);
  assert.equal(meta.isContainer, false);
});

test('lws://acl requires Control; lws://resource of a protected path is denied for anon (no-oracle)', async (t) => {
  const pod = await startLwsPod(t);
  const token = ownerBearer(pod);
  await seedTyped(pod, `/${pod.podName}/secret/s`, 'http://ex/Note'); // owner-private

  const anon = await read(pod, `lws://resource/${pod.podName}/secret/s`);
  assert.ok(anon.error, 'anon read denied');
  assert.match(anon.error.message, /access denied/i);

  const acl = await read(pod, `lws://acl/${pod.podName}/secret/s`, token);
  assert.ok(acl.result.contents, 'owner can read acl');
});
