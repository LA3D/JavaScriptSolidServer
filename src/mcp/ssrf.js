// src/mcp/ssrf.js
// SSRF guard for the MCP federation read arm (spec §6): readRemote fetches
// an arbitrary caller-supplied URL for a federation-gated agent — without
// this, LAN/loopback/cloud-metadata endpoints are reachable from inside the
// pod's trust boundary. Default-on; --lws-federation-private is the
// deliberate opt-in (the local rig fetching across containers on one host).
//
// Scoped fix: checks the LITERAL hostname/IP in the URL, not a network-layer
// translation of it. Three literal forms that a fabric/gateway could still
// translate to a private target are OUT of scope by the same rule, recorded
// (not expanded) — revisit only for a public IPv6-only build (dt8):
//   - DNS rebinding: a public name resolving to a private IP.
//   - NAT64 64:ff9b::/96: on an IPv6-only host with a NAT64 gateway,
//     [64:ff9b::a9fe:a9fe] translates to 169.254.169.254.
//   - IPv4-compatible ::a.b.c.d (deprecated, RFC 4291 §2.5.5.1): modern
//     stacks don't route it to the embedded IPv4.
// The local rig is dual-stack, so none is a live vector here.
//
// review #14: this file used to carry its OWN private-range table (PRIV4 +
// a local embeddedV4), which had drifted from src/utils/ssrf.js's isPrivateIP
// (missing 100.64.0.0/10 — Alibaba metadata 100.100.100.200, Tailscale; and
// TEST-NETs/multicast/reserved). isPrivateIP is now the ONE range table;
// this file is a thin hostname-normalizing wrapper around it (bracket-strip,
// net.isIP dispatch, the localhost/unspecified literals) that keeps this
// module's own literal-hostname-scope contract above.
import net from 'node:net';
import { isPrivateIP, embeddedV4 } from '../utils/ssrf.js';

export function isBlockedHost(hostname, { allowPrivate = false } = {}) {
  if (allowPrivate) return false;
  // Strip URL-bracket notation FIRST — `new URL(url).hostname` for an IPv6
  // literal is ALWAYS bracketed (`[fc00::1]`), and net.isIP()/isPrivateIP
  // only work on the bare address (dt8 fix round 1: this was dead code on
  // the real fetch path before the strip was added).
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost') return true;
  if (h === '0.0.0.0' || h === '::') return true;                   // unspecified
  if (net.isIP(h) === 6) {
    const v4 = embeddedV4(h);
    if (v4) return isPrivateIP(v4);
  }
  if (net.isIP(h)) return isPrivateIP(h);
  return false;
}
