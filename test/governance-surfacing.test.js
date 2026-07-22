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
