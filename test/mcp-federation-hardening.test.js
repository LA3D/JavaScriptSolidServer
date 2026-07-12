// test/mcp-federation-hardening.test.js
// dt8: the MCP federation arm (read_resource's remote branch, read-tools.js)
// fetches an arbitrary caller-supplied URL for a federation-gated agent with
// no SSRF guard and an unbounded `await r.text()` — the least-trusted
// content source, unlike local reads (readBounded/MAX_BODY_BYTES-capped).
// This covers: isBlockedHost's range table directly, readRemote's pre-fetch
// SSRF gate (default-blocked, --lws-federation-private opt-in via
// ctx.federationPrivate), and the size bound on the remote body read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isBlockedHost } from '../src/mcp/ssrf.js';
import { MAX_BODY_BYTES } from '../src/mcp/read.js';
import { callTool } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx } from './helpers.js';

// --- isBlockedHost: the range table, unit-level ---

test('isBlockedHost: loopback, RFC-1918, link-local, and cloud metadata are blocked by default', () => {
  for (const h of ['127.0.0.1', 'localhost', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.1.1', '169.254.169.254', '::1', '[::1]', 'fc00::1', 'fd12::3456', 'fe80::1']) {
    assert.equal(isBlockedHost(h), true, `expected ${h} blocked`);
  }
});

test('isBlockedHost: public hosts and out-of-range private-looking IPs are not blocked', () => {
  for (const h of ['8.8.8.8', 'example.com', '172.15.255.255', '172.32.0.1', '1.1.1.1']) {
    assert.equal(isBlockedHost(h), false, `expected ${h} not blocked`);
  }
});

test('isBlockedHost: allowPrivate overrides every check, including cloud metadata', () => {
  for (const h of ['127.0.0.1', '169.254.169.254', '10.0.0.1', 'fc00::1']) {
    assert.equal(isBlockedHost(h, { allowPrivate: true }), false, `expected ${h} allowed under allowPrivate`);
  }
});

// --- readRemote: pre-fetch SSRF gate ---

test('read_resource remote: loopback target is blocked by default (teaching error, never dialed)', async (t) => {
  let hit = false;
  const stub = http.createServer((req, res) => { hit = true; res.end('should not be reached'); });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => stub.close());
  const url = `http://127.0.0.1:${stub.address().port}/x`;

  const p = await startLwsPod(t);
  const res = await callTool('read_resource', { uri: url },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /federation blocked/);
  assert.match(res.content[0].text, /--lws-federation-private/);
  assert.equal(hit, false, 'the blocked host must never be dialed');
});

test('read_resource remote: cloud-metadata target is blocked by default (no live listener needed)', async (t) => {
  const p = await startLwsPod(t);
  const res = await callTool('read_resource', { uri: 'http://169.254.169.254/latest/meta-data/' },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /federation blocked/);
});

test('read_resource remote: --lws-federation-private (ctx.federationPrivate) opts back into a loopback target', async (t) => {
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => stub.close());
  const url = `http://127.0.0.1:${stub.address().port}/x`;

  const p = await startLwsPod(t);
  const res = await callTool('read_resource', { uri: url },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true, federationPrivate: true });
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  const out = JSON.parse(res.content[0].text);
  assert.match(out.body, /"ok":true/);
});

// --- readRemote: response-size bound ---

test('read_resource remote: an oversized remote body is truncated-with-flag, never fully buffered', async (t) => {
  const oversized = 'a'.repeat(MAX_BODY_BYTES + 50_000);
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(oversized);
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => stub.close());
  const url = `http://127.0.0.1:${stub.address().port}/big`;

  const p = await startLwsPod(t);
  const res = await callTool('read_resource', { uri: url },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true, federationPrivate: true });
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.truncated, true);
  assert.ok(out.body.length <= MAX_BODY_BYTES, `body length ${out.body.length} exceeds MAX_BODY_BYTES`);
});

test('read_resource remote: a body under the cap is not marked truncated', async (t) => {
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('small body');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => stub.close());
  const url = `http://127.0.0.1:${stub.address().port}/small`;

  const p = await startLwsPod(t);
  const res = await callTool('read_resource', { uri: url },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true, federationPrivate: true });
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.truncated, undefined);
  assert.match(out.body, /small body/);
});
