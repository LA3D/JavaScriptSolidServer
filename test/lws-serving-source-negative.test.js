// test/lws-serving-source-negative.test.js
// NEGATIVE CONTROL (spec 2026-07-11 §1): --lws off, the legacy arm is byte-identical —
// plain .json still flows through the legacy JSON-LD arm exactly as before this round.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl } from './helpers.js';

describe('negative control: --lws off, .json serving unchanged', () => {
  let base;
  before(async () => {
    await startTestServer({ lws: false, conneg: true });
    base = getBaseUrl();
    await createTestPod('seamneg');
    await request(`${base}/seamneg/d.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, auth: 'seamneg',
      body: JSON.stringify({ name: 'plain' }) });
  });
  after(stopTestServer);

  it('legacy arm still converts parseable JSON on a Turtle Accept (pre-round behavior)', async () => {
    const r = await request(`${base}/seamneg/d.json`, { headers: { Accept: 'text/turtle' }, auth: 'seamneg' });
    // Pre-round: legacy hand-rolled arm returns 200 text/turtle (empty preamble).
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type').split(';')[0], 'text/turtle');
  });

  it('markdown + specific RDF Accept still 200s the authored format when --lws is off', async () => {
    await request(`${base}/seamneg/card.md`, { method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'seamneg', body: '# x\n' });
    const r = await request(`${base}/seamneg/card.md`, { headers: { Accept: 'text/turtle' }, auth: 'seamneg' });
    assert.equal(r.status, 200);
  });
});
