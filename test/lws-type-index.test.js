import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, getBaseUrl, createTestPod, getPodToken } from './helpers.js';

const PERSON = 'https://schema.org/Person';

describe('type capture on write', () => {
  let base, token;
  before(async () => { await startTestServer({ lws: true }); base = getBaseUrl(); const p = await createTestPod('alice'); token = p.token; });
  after(async () => { await stopTestServer(); });

  it('PUT with Link rel=type persists the type (visible in the resource linkset)', async () => {
    const url = `${base}/alice/p1`;
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
                 Link: `<${PERSON}>; rel="type"` },
      body: JSON.stringify({ name: 'Alice' }),
    });
    assert.equal(put.status, 201);
    const ls = await fetch(url, { headers: { Accept: 'application/linkset+json', Authorization: `Bearer ${token}` } });
    const body = await ls.json();
    const types = body.linkset[0].type.map((t) => t.href);
    assert.ok(types.includes(PERSON), `linkset type should include ${PERSON}, got ${types}`);
    assert.ok(types.includes('https://www.w3.org/ns/lws#DataResource'));
  });
});
