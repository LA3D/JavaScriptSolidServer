// test/lws-sidecar-listing.test.js
// Regression pin (2026-07-13): the referent round's content-derived type
// enrichment (subjectTypesFromBody in applyLwsWrite, src/lws/write.js) writes
// a `.lwstypes` sidecar whenever a PUT body has a typed subject. Container
// listing renderers only hid BARE dotfiles (`.acl`/`.meta`/…), not
// suffix-style sidecars like `name.jsonld.lwstypes` — so a typed member's
// sidecar leaked into both `ldp:contains` and `items[]`. Fixed by extending
// both container-listing filters (src/ldp/container.js) to also drop
// AUX_SUFFIX matches (src/storage/filesystem.js), and by skipping
// type-capture entirely for auxiliary writes (src/lws/write.js).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus } from './helpers.js';

const TYPED = '/alice/public/typed-member.jsonld';

describe('typed-member sidecars never leak into container listings', () => {
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    await createTestPod('alice');
    const base = getBaseUrl();
    // Body with a typed #it subject — triggers .lwstypes sidecar capture.
    const r = await request(TYPED, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@id': `${base}${TYPED}#it`, '@type': 'https://example.org/ex#Thing', 'http://purl.org/dc/terms/title': 'typed' }),
    });
    assert.ok([200, 201, 204].includes(r.status), `setup PUT ${r.status}`);
  });
  after(async () => { await stopTestServer(); });

  it('anonymous ldp:contains listing includes the member but not its .lwstypes/.acl/.meta sidecars', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes('typed-member.jsonld"'), 'the member itself must still be listed');
    assert.ok(!body.includes('.lwstypes'), 'no .lwstypes sidecar in ldp:contains');
    assert.ok(!body.includes('typed-member.jsonld.acl'), 'no .acl sidecar in ldp:contains');
    assert.ok(!body.includes('typed-member.jsonld.meta'), 'no .meta sidecar in ldp:contains');
  });

  it('anonymous items[] listing includes the member but not its .lwstypes/.acl/.meta sidecars', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/lws+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes('typed-member.jsonld"'), 'the member itself must still be listed');
    assert.ok(!body.includes('.lwstypes'), 'no .lwstypes sidecar in items[]');
    assert.ok(!body.includes('typed-member.jsonld.acl'), 'no .acl sidecar in items[]');
    assert.ok(!body.includes('typed-member.jsonld.meta'), 'no .meta sidecar in items[]');
  });

  it('the owner sees the same: member listed, sidecars hidden', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' }, auth: 'alice' });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes('typed-member.jsonld"'));
    assert.ok(!body.includes('.lwstypes'));
  });
});
