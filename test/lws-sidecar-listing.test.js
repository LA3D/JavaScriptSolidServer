// test/lws-sidecar-listing.test.js
// Regression pin (2026-07-13): the referent round's content-derived type
// enrichment (subjectTypesFromBody in applyLwsWrite, src/lws/write.js) writes
// a `.lwstypes` sidecar whenever a PUT body has a typed subject. Container
// listing renderers only hid BARE dotfiles, not suffix-style System-Managed
// sidecars like `name.jsonld.lwstypes` — so a typed member's sidecar leaked
// into both `ldp:contains` and `items[]`. Fixed by narrowing both
// container-listing filters (src/ldp/container.js) to drop System-Managed
// suffix sidecars (`.lwstypes`/`.lwsprov` only — NOT `.acl`/`.meta`, which
// stay listed per DT7), and by skipping type-capture entirely for auxiliary
// writes (src/lws/write.js). This test asserts ONLY that System-Managed
// sidecars are hidden; `.acl`/`.meta` legitimately appear as members (DT7).
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

  it('anonymous ldp:contains listing includes the member but not its System-Managed .lwstypes/.lwsprov sidecars', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes('typed-member.jsonld"'), 'the member itself must still be listed');
    assert.ok(!body.includes('.lwstypes'), 'no .lwstypes sidecar in ldp:contains');
    assert.ok(!body.includes('.lwsprov'), 'no .lwsprov sidecar in ldp:contains');
  });

  it('anonymous items[] listing includes the member but not its System-Managed .lwstypes/.lwsprov sidecars', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/lws+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes('typed-member.jsonld"'), 'the member itself must still be listed');
    assert.ok(!body.includes('.lwstypes'), 'no .lwstypes sidecar in items[]');
    assert.ok(!body.includes('.lwsprov'), 'no .lwsprov sidecar in items[]');
  });

  it('the owner sees the same: member listed, System-Managed sidecars hidden', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' }, auth: 'alice' });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes('typed-member.jsonld"'));
    assert.ok(!body.includes('.lwstypes'));
  });
});
