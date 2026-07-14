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
import dns from 'node:dns/promises';
import { isBlockedHost, resolvesToBlockedHost } from '../src/mcp/ssrf.js';
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

// --- resolvesToBlockedHost: the resolve-and-check gap isBlockedHost can't
// close (a public-looking NAME that resolves to a private IP) ---

test('resolvesToBlockedHost blocks a name that resolves to a private IP', async () => {
  // localhost resolves to 127.0.0.1 / ::1 — both private, deterministic offline.
  assert.equal(await resolvesToBlockedHost('localhost', {}), true);
});

test('resolvesToBlockedHost allows a name that resolves to a public IP', async (t) => {
  // example.com resolves to public addresses — network-dependent; skip if
  // DNS is unreachable (offline/sandboxed CI) rather than false-fail.
  let addrs;
  try {
    addrs = await Promise.all([dns.resolve4('example.com'), dns.resolve6('example.com').catch(() => [])]);
  } catch {
    t.skip('no network / DNS resolution unavailable for example.com');
    return;
  }
  if (addrs[0].length === 0) {
    t.skip('example.com did not resolve to any A record');
    return;
  }
  const blocked = await resolvesToBlockedHost('example.com', {});
  assert.equal(blocked, false);
});

test('resolvesToBlockedHost is a no-op when allowPrivate', async () => {
  assert.equal(await resolvesToBlockedHost('localhost', { allowPrivate: true }), false);
});

test('resolvesToBlockedHost skips IP literals (handled by isBlockedHost)', async () => {
  assert.equal(await resolvesToBlockedHost('93.184.216.34', {}), false);
});

test('resolvesToBlockedHost fails closed when resolution errors (name does not exist)', async () => {
  assert.equal(await resolvesToBlockedHost('this-name-does-not-resolve.invalid', {}), true);
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

// fe80::/10 link-local (first hextet fe80–febf), not just literal fe80
test('isPrivateIP: full fe80::/10 link-local range (fe80–febf) is blocked', () => {
  for (const ip of ['fe80::1', 'fe81::1', 'fe9f::1', 'feaf::1', 'febf::1']) {
    assert.equal(isPrivateIP(ip), true, `${ip} is link-local (fe80::/10)`);
  }
  // fec0:: is site-local-deprecated, OUTSIDE fe80::/10 — must stay unblocked
  assert.equal(isPrivateIP('fec0::1'), false, 'fec0:: is not in fe80::/10');
});

// ff00::/8 multicast (first hextet ff00–ffff), not just literal ff00
test('isPrivateIP: full ff00::/8 multicast range (ff00–ffff) is blocked', () => {
  for (const ip of ['ff00::1', 'ff02::1', 'ff02::2', 'ff05::1', 'ff0e::1', 'ffff::1']) {
    assert.equal(isPrivateIP(ip), true, `${ip} is multicast (ff00::/8)`);
  }
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

// --- readRemote: per-hop redirect revalidation (review #8) ---
// dt8 fix round 1's redirect:'error' (CRITICAL 1) closed the redirect-follow
// bypass by refusing to follow ANY redirect — but that also dead-ended the
// pod's OWN cross-pod rails (e.g. the /.well-known/void 303). readRemote now
// follows redirects itself, re-running the SSRF guard on EVERY hop: a
// legitimate redirect between allowed hosts is followed (restoring the void
// rail), while a redirect hop that resolves to a blocked host is still
// refused before it's ever dialed (CRITICAL 1 stays closed).

test('read_resource remote: a 303 with a relative Location is followed with per-hop SSRF revalidation (#8): public->public followed', async (t) => {
  let finalHit = false;
  const target = http.createServer((req, res) => {
    finalHit = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  t.after(() => target.close());
  const targetPort = target.address().port;

  const source = http.createServer((req, res) => {
    // Protocol-relative Location — resolved against the CURRENT hop
    // (the source URL), not re-parsed from scratch.
    res.writeHead(303, { Location: `//127.0.0.1:${targetPort}/final` });
    res.end();
  });
  await new Promise((r) => source.listen(0, '127.0.0.1', r));
  t.after(() => source.close());
  const url = `http://127.0.0.1:${source.address().port}/void`;

  const p = await startLwsPod(t);
  // federationPrivate:true stands in for "these are allowed public hosts"
  // (same convention used elsewhere in this file) — isolates per-hop
  // redirect-following from the host-block guard, covered separately below.
  const res = await callTool('read_resource', { uri: url },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true, federationPrivate: true });
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  const out = JSON.parse(res.content[0].text);
  assert.equal(finalHit, true, 'the redirect target must actually be dialed (#8 restores following)');
  assert.equal(out.url, `http://127.0.0.1:${targetPort}/final`);
  assert.equal(out.resolvedFrom, url);
  assert.match(out.body, /"ok":true/);
});

test('read_resource remote: a redirect hop to a blocked host is refused with a teaching error naming the blocked target (never dialed)', async (t) => {
  // startLwsPod itself uses fetch (pod bootstrap) — install the mock AFTER
  // the pod is up, so only readRemote's own fetch calls are intercepted.
  const p = await startLwsPod(t);
  // hop 0's hostname (example.com) now goes through the per-hop DNS
  // pre-check (resolvesToBlockedHost) — mock it to a public IP so this test
  // stays hermetic (no live DNS) and reaches the mocked redirect below. The
  // redirect target (169.254.169.254) is an IP literal, so isBlockedHost
  // catches it directly without a DNS call.
  t.mock.method(dns, 'resolve4', async () => ['93.184.216.34']);
  t.mock.method(dns, 'resolve6', async () => []);
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input) => {
    const u = typeof input === 'string' ? input : input.url;
    if (u === 'https://example.com/void') {
      return new Response(null, { status: 303, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  });

  const res = await callTool('read_resource', { uri: 'https://example.com/void' },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /federation blocked/);
  assert.match(res.content[0].text, /169\.254\.169\.254/);
  assert.equal(fetchMock.mock.callCount(), 1, 'the blocked redirect target must never be dialed');
});

test('read_resource remote: stops after MAX_REDIRECT_HOPS with a teaching error (no unbounded redirect chain)', async (t) => {
  const p = await startLwsPod(t);
  // every hop here is the hostname example.com (never an IP literal), so
  // each iteration of the loop re-triggers the DNS pre-check — mock it to a
  // public IP so the test stays hermetic and the hop-cap logic (not a
  // live-DNS failure) is what's actually exercised.
  t.mock.method(dns, 'resolve4', async () => ['93.184.216.34']);
  t.mock.method(dns, 'resolve6', async () => []);
  let calls = 0;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(null, { status: 302, headers: { Location: `https://example.com/hop${calls}` } });
  });

  const res = await callTool('read_resource', { uri: 'https://example.com/hop0' },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /too many redirects/);
  assert.equal(fetchMock.mock.callCount(), 3, 'capped at MAX_REDIRECT_HOPS fetches, no more');
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

// --- readRemote: DNS pre-check (resolvesToBlockedHost wired into the hop
// loop) — a hostname whose LITERAL form isBlockedHost lets through but which
// RESOLVES to a private address must still be blocked before the fetch. ---

test('read_resource remote: a public-looking hostname that resolves to a private IP is blocked (never dialed)', async (t) => {
  const p = await startLwsPod(t);
  t.mock.method(dns, 'resolve4', async () => ['169.254.169.254']);
  t.mock.method(dns, 'resolve6', async () => []);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not be dialed — blocked at the DNS pre-check');
  });

  const res = await callTool('read_resource', { uri: 'https://sneaky.example.invalid/x' },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /federation blocked/);
  assert.match(res.content[0].text, /resolves to a private\/internal address/);
  assert.equal(fetchMock.mock.callCount(), 0, 'DNS-resolved-private host must never be dialed');
});

test('read_resource remote: --lws-federation-private also opts out of the DNS pre-check (rig hostnames resolve to 127.0.0.1)', async (t) => {
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => stub.close());
  const port = stub.address().port;

  const p = await startLwsPod(t);
  t.mock.method(dns, 'resolve4', async () => ['127.0.0.1']);
  t.mock.method(dns, 'resolve6', async () => []);
  const realFetch = globalThis.fetch;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => realFetch(`http://127.0.0.1:${port}/x`));

  const res = await callTool('read_resource', { uri: 'https://rig.example.invalid/x' },
    { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true, federationPrivate: true });
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  assert.equal(fetchMock.mock.callCount(), 1);
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
