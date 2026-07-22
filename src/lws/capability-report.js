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
  }
  L.push(`  mcp                  ${on(config.mcp)}`);
  return L.join('\n');
}
