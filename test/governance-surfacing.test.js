// test/governance-surfacing.test.js
// Governance round: owner in the per-storage description, provider on the
// ServerIndex/root description. Gating is inherited from the routes' existing
// READ checks — no new oracle to test, just presence/absence of properties.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, createTestPod, getBaseUrl } from './helpers.js';

const PROVIDER = 'https://org.example/profile/card#it';

describe('governance surfacing (description + ServerIndex + provider)', () => {
  let base, pod;
  before(async () => {
    await startTestServer({ lws: true, mcp: true, lwsProvider: PROVIDER });
    pod = await createTestPod('govsurf');
    base = getBaseUrl();
  });
  after(async () => { await stopTestServer(); });

  it('per-storage description carries owner (solid:owner URIs)', async () => {
    const res = await fetch(`${base}/govsurf/lws-storage`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.owner, [pod.webId]);
  });

  it('ServerIndex carries provider; per-storage description does not', async () => {
    const idx = await (await fetch(`${base}/.well-known/lws-storage`)).json();
    assert.equal(idx.provider, PROVIDER);
    const desc = await (await fetch(`${base}/govsurf/lws-storage`)).json();
    assert.equal(desc.provider, undefined);
  });

  it('without --lws-provider no provider key appears', async () => {
    await stopTestServer();
    await startTestServer({ lws: true });
    const idx = await (await fetch(`${getBaseUrl()}/.well-known/lws-storage`)).json();
    assert.equal(idx.provider, undefined);
  });
});

// "One builder, two surfaces agreeing" — the MCP resources/read mirror of the
// same two HTTP routes above must carry the identical owner/provider fields.
// Round-trips through the real /mcp HTTP route (not a hand-built ctx), same
// pattern as test/mcp-lws-read.test.js's "mirrors" tests.
describe('governance surfacing — MCP mirror parity', () => {
  let base, pod;
  before(async () => {
    await startTestServer({ lws: true, mcp: true, lwsProvider: PROVIDER });
    pod = await createTestPod('govmcp');
    base = getBaseUrl();
  });
  after(async () => { await stopTestServer(); });

  async function mcpRead(uri) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'resources/read',
        params: { uri },
      }),
    });
    const json = await res.json();
    return JSON.parse(json.result.contents[0].text);
  }

  it('MCP per-storage description carries owner, matching HTTP', async () => {
    const httpBody = await (await fetch(`${base}/govmcp/lws-storage`)).json();
    const mcpBody = await mcpRead(`${base}/govmcp/lws-storage`);
    assert.deepEqual(mcpBody.owner, httpBody.owner);
    assert.deepEqual(mcpBody.owner, [pod.webId]);
  });

  it('MCP ServerIndex carries provider, matching HTTP; per-storage description still omits it', async () => {
    const httpIdx = await (await fetch(`${base}/.well-known/lws-storage`)).json();
    const mcpIdx = await mcpRead(`${base}/.well-known/lws-storage`);
    assert.equal(mcpIdx.provider, httpIdx.provider);
    assert.equal(mcpIdx.provider, PROVIDER);

    const mcpDesc = await mcpRead(`${base}/govmcp/lws-storage`);
    assert.equal(mcpDesc.provider, undefined);
  });
});
