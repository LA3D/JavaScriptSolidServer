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

test('resources/templates/list advertises the lws:// templates', async (t) => {
  const pod = await startLwsPod(t);
  const { body } = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'resources/templates/list', params: {} });
  const uris = body.result.resourceTemplates.map(r => r.uriTemplate);
  assert.ok(uris.includes('lws://resource/{+path}'));
  assert.ok(uris.includes('lws://linkset/{+path}'));
});

test('resources/list includes lws://pod-info and resources/read returns it', async (t) => {
  const pod = await startLwsPod(t);
  const list = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} },
    { Authorization: `Bearer ${ownerBearer(pod)}` });
  assert.ok(list.body.result.resources.some(r => r.uri === 'lws://pod-info'));

  const read = await postMcp(pod, { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'lws://pod-info' } },
    { Authorization: `Bearer ${ownerBearer(pod)}` });
  const c = read.body.result.contents[0];
  assert.equal(c.uri, 'lws://pod-info');
  const info = JSON.parse(c.text);
  assert.equal(info.server, 'jss');
});

test('resources/read of an unknown URI is a JSON-RPC error, not a throw', async (t) => {
  const pod = await startLwsPod(t);
  const { body } = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'lws://bogus/x' } });
  assert.ok(body.error, 'error present');
  assert.match(body.error.message, /unknown resource/i);
});
