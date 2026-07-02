import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAuthorizedResources } from '../src/lws/authorized-resources.js';
import { callTool } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx, seedTyped, startTestServer, stopTestServer, getBaseUrl } from './helpers.js';

test('collectAuthorizedResources drops resources the agent cannot read (no oracle)', async (t) => {
  const pod = await startLwsPod(t);
  await seedTyped(pod, '/lwsmcp/pub/a', 'https://ex/Note', { publicRead: true });
  await seedTyped(pod, '/lwsmcp/priv/b', 'https://ex/Note', { publicRead: false });
  const anon = await collectAuthorizedResources({ agentWebId: null, origin: pod.origin });
  const ids = anon.map((r) => r.id);
  assert.ok(ids.some((i) => i.endsWith('/lwsmcp/pub/a')));
  assert.equal(ids.some((i) => i.endsWith('/lwsmcp/priv/b')), false, 'private resource invisible to anon');
});

test('lws_type_search returns only WAC-readable matches', async (t) => {
  const pod = await startLwsPod(t);
  await seedTyped(pod, '/lwsmcp/pub/a', 'https://ex/Note', { publicRead: true });
  await seedTyped(pod, '/lwsmcp/priv/b', 'https://ex/Note', { publicRead: false });
  const res = await callTool('lws_type_search',
    { type: ['https://ex/Note'] }, { webId: null, origin: pod.origin });
  const body = JSON.parse(res.content?.[0]?.text ?? res.text);
  assert.equal(body.items.length, 1);
});

test('lws_type_search owner sees both public and private matches', async (t) => {
  const pod = await startLwsPod(t);
  await seedTyped(pod, '/lwsmcp/pub/a', 'https://ex/Note', { publicRead: true });
  await seedTyped(pod, '/lwsmcp/priv/b', 'https://ex/Note', { publicRead: false });
  const res = await callTool('lws_type_search',
    { type: ['https://ex/Note'] }, ownerCtx(pod));
  const body = JSON.parse(res.content?.[0]?.text ?? res.text);
  assert.equal(body.items.length, 2);
});

test('lws_linkset returns anchor/type for a resource, WAC-gated', async (t) => {
  const pod = await startLwsPod(t);
  await seedTyped(pod, '/lwsmcp/pub/a', 'https://ex/Note', { publicRead: true });

  const res = await callTool('lws_linkset', { path: '/lwsmcp/pub/a' }, { webId: null, origin: pod.origin });
  const body = JSON.parse(res.content?.[0]?.text ?? res.text);
  const link = body.linkset[0];
  assert.equal(link.anchor, `${pod.origin}/lwsmcp/pub/a`);
  assert.ok(link.type.some((t) => t.href === 'https://ex/Note'));

  await seedTyped(pod, '/lwsmcp/priv/b', 'https://ex/Note', { publicRead: false });
  const denied = await callTool('lws_linkset', { path: '/lwsmcp/priv/b' }, { webId: null, origin: pod.origin });
  assert.ok(denied.isError, 'anonymous must be denied linkset for a private resource');
});

// Round-trips through the real /mcp HTTP route (not a hand-built ctx) so
// this actually exercises the typeIndexEnabled/notificationsEnabled wiring
// from request -> ctx -> buildStorageDescription, proving the MCP tool and
// the HTTP /.well-known/lws-storage route can't drift apart.
test('lws_storage_description mirrors /.well-known/lws-storage', async (t) => {
  await startTestServer({ lws: true, mcp: true });
  t.after(async () => { await stopTestServer(); });
  const base = getBaseUrl();

  const httpRes = await fetch(`${base}/.well-known/lws-storage`);
  const httpBody = await httpRes.json();

  const mcpRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'lws_storage_description', arguments: {} },
    }),
  });
  const mcpJson = await mcpRes.json();
  const toolBody = JSON.parse(mcpJson.result.content[0].text);

  assert.deepEqual(toolBody.service, httpBody.service);
  assert.equal(toolBody.type, 'Storage');
});

// Edge combo: liveReload on, notifications explicitly off. The
// NotificationService plugin is still registered in this combo
// (notificationsEnabled || liveReloadEnabled, src/server.js ~464), and the
// request-level decoration used by both surfaces agrees (~397). Before the
// fix, the HTTP route passed the raw (false) notifications flag and
// under-advertised NotificationService while the MCP ctx (which reads
// request.notificationsEnabled) correctly advertised it — this proves both
// surfaces now agree, matching actual service registration.
test('lws_storage_description and HTTP route agree when liveReload is on but notifications is off', async (t) => {
  await startTestServer({ lws: true, mcp: true, liveReload: true, notifications: false });
  t.after(async () => { await stopTestServer(); });
  const base = getBaseUrl();

  const httpRes = await fetch(`${base}/.well-known/lws-storage`);
  const httpBody = await httpRes.json();

  const mcpRes = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'lws_storage_description', arguments: {} },
    }),
  });
  const mcpJson = await mcpRes.json();
  const toolBody = JSON.parse(mcpJson.result.content[0].text);

  const httpHasNotify = httpBody.service.some((s) => s.type === 'NotificationService');
  const mcpHasNotify = toolBody.service.some((s) => s.type === 'NotificationService');
  assert.equal(httpHasNotify, true, 'HTTP route must advertise NotificationService when liveReload is on');
  assert.equal(mcpHasNotify, true, 'MCP ctx must advertise NotificationService when liveReload is on');
  assert.deepEqual(toolBody.service, httpBody.service);
});
