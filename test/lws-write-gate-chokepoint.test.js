// test/lws-write-gate-chokepoint.test.js
// Review 2026-07-12 #2/#10: the name/type gate must hold at EVERY write
// surface (it lived at the 2 HTTP call sites only), and application/json
// must gate as JSON-LD (the rest of the pipeline already treats it so).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx, request, createTestPod, startTestServer, stopTestServer, assertStatus } from './helpers.js';

test('MCP write_resource: text/plain body at a .ttl name is refused (gate at choke point)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const r = await callTool('write_resource', {
    path: `/${p.podName}/evil.ttl`, content: 'not turtle at all', // contentType omitted -> text/plain
  }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /name implies text\/turtle/);
});

test('MCP write_resource: Turtle body at a .jsonld name is refused', async (t) => {
  const p = await startLwsPod(t);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const r = await callTool('write_resource', {
    path: `/${p.podName}/lie.jsonld`, content: '<#s> <#p> <#o>.', contentType: 'text/turtle',
  }, ctx);
  assert.equal(r.isError, true);
});

test('MCP put_typed_resource: extensionless write still passes (JSS idiom preserved)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const r = await callTool('put_typed_resource', {
    path: `/${p.podName}/shape1`, content: JSON.stringify({ '@id': '#it' }), contentType: 'application/ld+json',
  }, ctx);
  assert.equal(r.isError, false);
});

test('HTTP PUT: application/json at .ttl name 400s; at .jsonld name passes (#10)', async () => {
  await startTestServer({ lws: true, conneg: true });
  try {
    await createTestPod('gatejson');
    const bad = await request('/gatejson/x.ttl', {
      method: 'PUT', auth: 'gatejson',
      headers: { 'Content-Type': 'application/json' }, body: '{"a":1}',
    });
    assertStatus(bad, 400);
    const ok = await request('/gatejson/x.jsonld', {
      method: 'PUT', auth: 'gatejson',
      headers: { 'Content-Type': 'application/json' }, body: '{"a":1}',
    });
    assert.ok(ok.status === 201 || ok.status === 204 || ok.status === 200);
    const plain = await request('/gatejson/y.ttl', {
      method: 'PUT', auth: 'gatejson',
      headers: { 'Content-Type': 'text/plain' }, body: 'junk',
    });
    assertStatus(plain, 400);
  } finally { await stopTestServer(); }
});

test('HTTP PUT: gate problem.instance echoes the resource URL, not storage path', async () => {
  await startTestServer({ lws: true, conneg: true });
  try {
    await createTestPod('gateinstance');
    const response = await request('/gateinstance/z.ttl', {
      method: 'PUT', auth: 'gateinstance',
      headers: { 'Content-Type': 'application/json' }, body: '{"a":1}',
    });
    assertStatus(response, 400);
    const problem = await response.json();
    assert.ok(problem.instance.startsWith('http://'), 'instance should be a full HTTP URL');
    assert.ok(problem.instance.includes('/gateinstance/z.ttl'), 'instance should include the request path');
    assert.ok(!problem.instance.includes('.stored'), 'instance should not be a storage path');
  } finally { await stopTestServer(); }
});
