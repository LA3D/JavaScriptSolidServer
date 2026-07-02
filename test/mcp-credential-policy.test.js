/**
 * Credential-tier seam for /mcp (Task 6).
 *
 * `mcpCredentialPolicy` defaults to `'trusted-local'` (today's behavior: any
 * webId-resolving bearer is accepted, same as every other JSS route). Setting
 * it to `'audience-bound'` refuses the replayable RS256 bearer on /mcp and
 * requires an audience-bound credential class (LWS-CID or Solid-OIDC DPoP) —
 * detected by header shape via hasLwsCidAuth/hasSolidOidcAuth, the same
 * detectors the auth dispatch already uses.
 *
 * The CID/DPoP *accept* path needs a public-IP host (JSS's SSRF guard blocks
 * CID doc-fetch on a private IP) — see test/mcp-cid-e2e.test.js for that
 * forcing function. This file only covers the reject path, which is pure
 * header-shape logic and runs fully locally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, createTestPod, getPodToken, postMcp, ownerBearer } from './helpers.js';

async function startMcpPod(t, options = {}) {
  const { baseUrl } = await startTestServer({ mcp: true, ...options });
  const created = await createTestPod('credpol');
  const token = getPodToken('credpol');
  if (t && typeof t.after === 'function') {
    t.after(async () => { await stopTestServer(); });
  }
  return { origin: baseUrl, token, webId: created.webId };
}

test('audience-bound policy refuses the replayable RS256 bearer on /mcp', async (t) => {
  const pod = await startMcpPod(t, { mcpCredentialPolicy: 'audience-bound' });
  const res = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { Authorization: `Bearer ${ownerBearer(pod)}` });
  assert.equal(res.body.error?.code, -32001 /* auth error */);
});

test('trusted-local policy (default) still accepts the bearer', async (t) => {
  const pod = await startMcpPod(t);
  const res = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { Authorization: `Bearer ${ownerBearer(pod)}` });
  assert.ok(res.body.result);
});
