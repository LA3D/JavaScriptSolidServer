import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, listToolsForRpc } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx } from './helpers.js';

test('tool registry is the 7 core + 2 convenience set (<= 9)', () => {
  const names = listToolsForRpc().map(t => t.name).sort();
  assert.deepEqual(names, [
    'create_resource', 'delete_resource', 'describe_resource',
    'lws_type_search', 'put_typed_resource', 'read_remote_resource', 'subscribe', 'write_acl', 'write_resource',
  ]);
});

test('put_typed_resource writes + captures type; describe_resource returns body+linkset+types', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };

  const put = await callTool('put_typed_resource', {
    path: `/${pod.podName}/things/x`,
    content: '{}', contentType: 'application/ld+json',
    types: ['http://ex/Thing'],
  }, ctx);
  assert.equal(put.isError ?? false, false, JSON.stringify(put));

  const desc = await callTool('describe_resource', { path: `/${pod.podName}/things/x` }, ctx);
  const d = JSON.parse(desc.content[0].text);
  assert.ok(d.body !== undefined);
  assert.ok(d.linkset);
  assert.ok(d.types.includes('http://ex/Thing'));
});
