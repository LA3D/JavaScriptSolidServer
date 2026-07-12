// test/mcp-federation-hardening.test.js
// dt8: the MCP federation arm (read_resource's remote branch, read-tools.js)
// fetches an arbitrary caller-supplied URL for a federation-gated agent with
// no SSRF guard and an unbounded `await r.text()` — the least-trusted
// content source, unlike local reads (readBounded/MAX_BODY_BYTES-capped).
// This covers: isBlockedHost's range table directly, readRemote's pre-fetch
// SSRF gate (default-blocked, --lws-federation-private opt-in via
// ctx.federationPrivate), and the size bound on the remote body read.
//
// Fix round 1 (adversarial review, dt8 task 8): three real bypasses were
// found and closed here — see src/mcp/ssrf.js and src/mcp/read-tools.js for
// the fix commentary. The IPv6 unit tests below were REWRITTEN, not just
// extended: the original tests fed isBlockedHost bare strings like
// 'fc00::1', which net.isIP() accepts but which the real fetch path NEVER
// produces (`new URL(url).hostname` for an IPv6 literal is ALWAYS bracketed,
// `[fc00::1]`) — that was a false-green. Every IPv6 case below now drives
// hostnames as `new URL(...).hostname` actually produces them, or asserts
// straight through read_resource -> readRemote -> isBlockedHost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isBlockedHost } from '../src/mcp/ssrf.js';
import { isPrivateIP } from '../src/utils/ssrf.js';
import { MAX_BODY_BYTES } from '../src/mcp/read.js';
import { callTool } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx } from './helpers.js';

// --- isBlockedHost: the range table, unit-level ---

test('isBlockedHost: loopback, RFC-1918, link-local, and cloud metadata (IPv4) are blocked by default', () => {
  for (const h of ['127.0.0.1', 'localhost', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.1.1', '169.254.169.254']) {
    assert.equal(isBlockedHost(h), true, `expected ${h} blocked`);
  }
});

test('isBlockedHost: public hosts and out-of-range private-looking IPs are not blocked', () => {
  for (const h of ['8.8.8.8', 'example.com', '172.15.255.255', '172.32.0.1', '1.1.1.1']) {
    assert.equal(isBlockedHost(h), false, `expected ${h} not blocked`);
  }
});

test('isBlockedHost: allowPrivate overrides every check, including cloud metadata', () => {
  for (const h of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '[fc00::1]', '0.0.0.0', '[::]']) {
    assert.equal(isBlockedHost(h, { allowPrivate: true }), false, `expected ${h} allowed under allowPrivate`);
  }
});

// --- isBlockedHost: IPv6, driven through the REAL production shape ---
// (dt8 fix round 1, CRITICAL 2 — bracketed hostnames + IPv4-mapped IPv6)

test('isBlockedHost: hostnames as new URL(...).hostname ACTUALLY produces them (bracketed) are blocked — ULA/link-local/loopback/unspecified/IPv4-mapped', () => {
  const blockedUrls = [
    'http://[fc00::1]/x',                    // ULA
    'http://[fd12::3456]/x',                 // ULA
    'http://[fe80::1]/x',                    // link-local
    'http://[::1]/x',                        // loopback
    'http://[::]/x',                         // unspecified
    'http://[::ffff:169.254.169.254]/x',     // IPv4-mapped -> cloud metadata
    'http://[::ffff:10.0.0.1]/x',            // IPv4-mapped -> RFC-1918
    'http://[::ffff:127.0.0.1]/x',           // IPv4-mapped -> loopback
  ];
  for (const u of blockedUrls) {
    const hostname = new URL(u).hostname;
    assert.equal(isBlockedHost(hostname), true, `expected ${u} (hostname=${hostname}) blocked`);
  }
});

test('isBlockedHost: bracketed IPv4-mapped IPv6 in dotted-quad form is blocked too (not just the URL-normalized hex form)', () => {
  for (const h of ['[::ffff:169.254.169.254]', '[::ffff:10.0.0.1]', '[::ffff:127.0.0.1]']) {
    assert.equal(isBlockedHost(h), true, `expected ${h} blocked`);
  }
});

test('isBlockedHost: unspecified addresses (0.0.0.0, ::, [::]) are blocked', () => {
  for (const h of ['0.0.0.0', '::', '[::]']) {
    assert.equal(isBlockedHost(h), true, `expected ${h} blocked`);
  }
});

// --- isBlockedHost/isPrivateIP: one shared range table (review #14) ---
// mcp/ssrf.js used to carry its OWN hand-rolled private-range table, missing
// 100.64.0.0/10 (Alibaba cloud metadata 100.100.100.200, Tailscale) even
// though src/utils/ssrf.js's isPrivateIP already blocked it — two divergent
// lists. isBlockedHost now delegates to isPrivateIP as the ONE table.

test('isBlockedHost blocks 100.64/10 incl. Alibaba metadata, mapped-IPv6 form too', () => {
  assert.equal(isBlockedHost('100.100.100.200'), true);
  assert.equal(isBlockedHost('100.64.0.1'), true);
  assert.equal(isBlockedHost('[::ffff:6464:64c8]'), true);   // 100.100.100.200 hex-mapped
  assert.equal(isBlockedHost('[::ffff:100.100.100.200]'), true);
  assert.equal(isBlockedHost('fc01::1'), true);              // fc00::/7, not just fc00:
  assert.equal(isBlockedHost('8.8.8.8'), false);
});

test('utils isPrivateIP gains the hex-group mapped form (importers inherit)', () => {
  assert.equal(isPrivateIP('::ffff:a9fe:a9fe'), true);       // 169.254.169.254
});

// --- readRemote: the same bypasses, driven end-to-end through read_resource ---

test('read_resource remote: bracketed IPv6 (ULA/link-local/loopback) targets are blocked by default (no live listener needed)', async (t) => {
  const p = await startLwsPod(t);
  for (const uri of ['http://[fc00::1]/x', 'http://[fe80::1]/x', 'http://[::1]/x']) {
    const res = await callTool('read_resource', { uri },
      { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
    assert.equal(res.isError, true, `expected ${uri} blocked`);
    assert.match(res.content[0].text, /federation blocked/, `expected ${uri} teaching error`);
  }
});

test('read_resource remote: IPv4-mapped IPv6 targets (::ffff:a.b.c.d) are blocked by default (no live listener needed)', async (t) => {
  const p = await startLwsPod(t);
  for (const uri of ['http://[::ffff:169.254.169.254]/x', 'http://[::ffff:10.0.0.1]/x', 'http://[::ffff:127.0.0.1]/x']) {
    const res = await callTool('read_resource', { uri },
      { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
    assert.equal(res.isError, true, `expected ${uri} blocked`);
    assert.match(res.content[0].text, /federation blocked/, `expected ${uri} teaching error`);
  }
});

test('read_resource remote: unspecified-address targets (0.0.0.0, [::]) are blocked by default (no live listener needed)', async (t) => {
  const p = await startLwsPod(t);
  for (const uri of ['http://0.0.0.0/x', 'http://[::]/x']) {
    const res = await callTool('read_resource', { uri },
      { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
    assert.equal(res.isError, true, `expected ${uri} blocked`);
    assert.match(res.content[0].text, /federation blocked/, `expected ${uri} teaching error`);
  }
});

// --- readRemote: malformed URL is a teaching error, not a throw (MINOR 4) ---

test('read_resource remote: a malformed URL returns a teaching error instead of throwing', async (t) => {
  const p = await startLwsPod(t);
  const res = await callTool('read_resource', { uri: 'http://[not-a-valid-host/x' },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /invalid remote URL/);
});

// --- readRemote: redirect-follow bypass (CRITICAL 1) ---

test('read_resource remote: a 302 redirect is NOT followed (redirect target is never dialed)', async (t) => {
  let redirectTargetHit = false;
  const target = http.createServer((req, res) => { redirectTargetHit = true; res.end('should not be reached'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  t.after(() => target.close());
  const targetPort = target.address().port;

  const source = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/metadata` });
    res.end();
  });
  await new Promise((r) => source.listen(0, '127.0.0.1', r));
  t.after(() => source.close());
  const url = `http://127.0.0.1:${source.address().port}/x`;

  const p = await startLwsPod(t);
  // federationPrivate:true bypasses the initial-host check on the SOURCE
  // url (a loopback stub standing in for "an allowed public host") so this
  // test isolates the redirect-follow bug from the host-block guard
  // (CRITICAL 2, covered above): the guard only ever sees the INITIAL host
  // in the URL — a redirect response must never be followed at all, to any
  // host, since the guard performs no per-hop recheck.
  const res = await callTool('read_resource', { uri: url },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true, federationPrivate: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /remote unreachable/);
  assert.equal(redirectTargetHit, false, 'the redirect target must never be dialed');
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
