// Boot-time capability ledger (guardrails round 2026-07-21). The audience is the coding agent
// that deploys this pod, not the agents that use it — those attach to /mcp and never read
// startup config. LOUD, NEVER FATAL: a wrong deploy must be visible in `docker logs`, but must
// not brick a rebuild. The red lives in the rig's tests/capabilities.test.mjs.
export function formatCapabilityReport(config, { configResolved } = {}) {
  const L = ['[lws-pod] capability report'];
  const on = (v) => (v ? 'ON ' : 'OFF');
  L.push(`  lws                  ${on(config.lws)}`);
  if (config.lws) {
    L.push(`  ├ type-index         ${on(config.lwsTypeIndex)}  (implied by --lws)`);
    L.push(`  └ profile-conneg     ${on(config.lwsProfileConneg)}  (implied by --lws)`);
    if (config.lwsConfig) {
      L.push(`  lws-config           ${config.lwsConfig}`);
      if (!configResolved) {
        L.push('                       ✗ NOT FOUND → profileIndex/void/uriSpaces services OFF');
      }
    } else {
      L.push('  lws-config           (none) → profileIndex/void/uriSpaces services OFF');
    }
    if (config.lwsProvider) L.push(`  provider             ${config.lwsProvider}`);
    // AS round (2026-07-24, task 1): the authorization-server role — on/off
    // plus its effective trusted issuer + exchanged-token TTL when on — and
    // the existing /idp/credentials direct-bearer path, named loud (it is
    // always on today; there is no flag to turn it off yet).
    if (config.lwsAs) {
      L.push(`  lws-as               ON  (as_uri=${config.lwsAsUri}, ttl=${config.lwsAsTtl}s)`);
    } else {
      L.push('  lws-as               OFF');
    }
    L.push('  trusted-local direct bearer: ON');
  }
  L.push(`  mcp                  ${on(config.mcp)}`);
  return L.join('\n');
}
