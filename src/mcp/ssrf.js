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
import net from 'node:net';

const PRIV4 = [/^127\./, /^10\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

function isBlockedV4(h) {
  if (h === '0.0.0.0') return true;                                // unspecified (dt8 fix round 1)
  if (h === '169.254.169.254') return true;                        // cloud metadata
  return PRIV4.some((re) => re.test(h));
}

// An IPv4-mapped IPv6 address (::ffff:a.b.c.d) embeds a real IPv4 target —
// e.g. ::ffff:169.254.169.254 reaches cloud metadata on Linux dual-stack
// hosts. `new URL(...).hostname` normalizes the embedded address to the
// compressed hex-group form (::ffff:a9fe:a9fe), but callers may also pass
// the dotted-quad form directly, so both are recognized here.
function embeddedV4(h) {
  let m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (m) return m[1];
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (m) {
    const hi = parseInt(m[1], 16);
    const lo = parseInt(m[2], 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
  }
  return null;
}

export function isBlockedHost(hostname, { allowPrivate = false } = {}) {
  if (allowPrivate) return false;
  // Strip URL-bracket notation FIRST — `new URL(url).hostname` for an IPv6
  // literal is ALWAYS bracketed (`[fc00::1]`), and net.isIP()/the prefix
  // checks below only work on the bare address (dt8 fix round 1: this was
  // dead code on the real fetch path before the strip was added).
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (h === '::') return true;                                      // IPv6 unspecified
  if (net.isIP(h) === 4) return isBlockedV4(h);
  if (net.isIP(h) === 6) {
    const v4 = embeddedV4(h);
    if (v4) return isBlockedV4(v4);
    if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  }
  return false;
}
