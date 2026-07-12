// src/mcp/ssrf.js
// SSRF guard for the MCP federation read arm (spec §6): readRemote fetches
// an arbitrary caller-supplied URL for a federation-gated agent — without
// this, LAN/loopback/cloud-metadata endpoints are reachable from inside the
// pod's trust boundary. Default-on; --lws-federation-private is the
// deliberate opt-in (the local rig fetching across containers on one host).
//
// Scoped fix: checks the LITERAL hostname/IP in the URL, not a DNS
// resolution — a public hostname that resolves to a private IP (DNS
// rebinding) is NOT caught here. A resolve-then-check is a larger change;
// recorded as a known limitation, not expanded into scope (dt8).
import net from 'node:net';

const PRIV4 = [/^127\./, /^10\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

export function isBlockedHost(hostname, { allowPrivate = false } = {}) {
  if (allowPrivate) return false;
  const h = (hostname || '').toLowerCase();
  if (h === 'localhost' || h === '[::1]' || h === '::1') return true;
  if (h === '169.254.169.254') return true;                       // cloud metadata
  if (net.isIP(h) === 4) return PRIV4.some((re) => re.test(h));
  if (net.isIP(h) === 6 && (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80'))) return true;
  return false;
}
