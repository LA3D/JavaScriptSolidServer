// test/mcp-v2-resources-primitive.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, postMcp, ownerBearer } from './helpers.js';

test('initialize advertises the resources capability', async (t) => {
  const pod = await startLwsPod(t);
  const { body } = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.ok(body.result.capabilities.resources, 'resources capability present');
  assert.equal(body.result.capabilities.resources.listChanged, false);
});

test('resources/templates/list advertises the one real-URL template', async (t) => {
  const pod = await startLwsPod(t);
  const { body } = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'resources/templates/list', params: {} });
  const uris = body.result.resourceTemplates.map(r => r.uriTemplate);
  assert.deepEqual(uris, ['https://{+authority}/{+path}']);
});

test('resources/list includes pod-info at its real URL and resources/read returns it', async (t) => {
  const pod = await startLwsPod(t);
  const podInfoUri = `${pod.origin}/.well-known/mcp/pod-info`;
  const list = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} },
    { Authorization: `Bearer ${ownerBearer(pod)}` });
  assert.ok(list.body.result.resources.some(r => r.uri === podInfoUri));

  const read = await postMcp(pod, { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: podInfoUri } },
    { Authorization: `Bearer ${ownerBearer(pod)}` });
  const c = read.body.result.contents[0];
  assert.equal(c.uri, podInfoUri);
  const info = JSON.parse(c.text);
  assert.equal(info.server, 'jss');
});

test('resources/read of a non-local URI is a JSON-RPC error, not a throw', async (t) => {
  const pod = await startLwsPod(t);
  const { body } = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'lws://bogus/x' } });
  assert.ok(body.error, 'error present');
  assert.match(body.error.message, /not a local resource/i);
});
