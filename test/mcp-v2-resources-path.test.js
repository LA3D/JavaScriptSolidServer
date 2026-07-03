import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, postMcp, ownerBearer, seedTyped } from './helpers.js';

async function read(pod, uri, token) {
  const { body } = await postMcp(pod,
    { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } },
    token ? { Authorization: `Bearer ${token}` } : {});
  return body;
}

async function describeResource(pod, path, token) {
  const { body } = await postMcp(pod,
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'describe_resource', arguments: { path } } },
    token ? { Authorization: `Bearer ${token}` } : {});
  return body;
}

test('a resource URL returns a body; describe_resource carries the typed linkset', async (t) => {
  const pod = await startLwsPod(t);
  const token = ownerBearer(pod);
  const url = await seedTyped(pod, `/${pod.podName}/notes/a`, 'http://ex/Note', { publicRead: true });
  assert.ok(url);

  const body = await read(pod, `${pod.base}/${pod.podName}/notes/a`, token);
  assert.ok(body.result.contents[0].text.length > 0);

  // linkset is no longer a resource kind; describe_resource is its carrier
  const desc = await describeResource(pod, `/${pod.podName}/notes/a`, token);
  assert.equal(desc.result.isError, false, desc.result.content?.[0]?.text);
  const parsed = JSON.parse(desc.result.content[0].text);
  assert.ok(parsed.linkset.linkset[0].type.some(x => x.href === 'http://ex/Note'));
});

test('a container URL lists children (lws+json); an X.meta URL returns size/modified', async (t) => {
  const pod = await startLwsPod(t);
  const token = ownerBearer(pod);
  await seedTyped(pod, `/${pod.podName}/notes/a`, 'http://ex/Note');

  const c = await read(pod, `${pod.base}/${pod.podName}/notes/`, token);
  const listing = JSON.parse(c.result.contents[0].text);
  assert.equal(listing.type, 'Container');
  assert.ok(listing.items.some(i => i.id.endsWith('/notes/a')));

  const m = await read(pod, `${pod.base}/${pod.podName}/notes/a.meta`, token);
  const meta = JSON.parse(m.result.contents[0].text);
  assert.equal(meta.isContainer, false);
});

test('an X.acl URL requires Control; a protected resource URL is denied for anon (no-oracle)', async (t) => {
  const pod = await startLwsPod(t);
  const token = ownerBearer(pod);
  await seedTyped(pod, `/${pod.podName}/secret/s`, 'http://ex/Note'); // owner-private

  const anon = await read(pod, `${pod.base}/${pod.podName}/secret/s`);
  assert.ok(anon.error, 'anon read denied');
  assert.match(anon.error.message, /access denied/i);

  const acl = await read(pod, `${pod.base}/${pod.podName}/secret/s.acl`, token);
  assert.ok(acl.result.contents, 'owner can read acl');
});
