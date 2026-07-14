// test/lws-listing-authz.test.js
// S1 (spec 2026-07-10 §4): the container LISTING is WAC-filtered per member
// under --lws — the same checkAccess()-and-drop discipline as /types/*
// (src/lws/authorized-resources.js: "the filter IS the authz boundary").
// Hide, never 401 — no discovery oracle. Closes the probe-#3 existence leak.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const PUB = '/alice/public/listing-open.jsonld';
const PRIV = '/alice/public/listing-private.jsonld';

describe('WAC-filtered container listing (--lws)', () => {
  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    const alice = await createTestPod('alice');
    const base = getBaseUrl();
    await request(PUB, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@id': `${base}${PUB}`, note: 'open' }) });
    await request(PRIV, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@id': `${base}${PRIV}`, note: 'private' }) });
    // Owner-only resource ACL overrides the folder's inherited public-read
    // (resource ACL wins — src/wac/checker.js findApplicableAcl).
    const aclRes = await request(`${PRIV}.acl`, { method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: serializeAcl(generatePrivateAcl(`${base}${PRIV}`, alice.webId, false)) });
    assert.ok([200, 201, 204].includes(aclRes.status));
  });
  after(async () => { await stopTestServer(); });

  it('anonymous LDP listing hides the unreadable member (ldp:contains)', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes('listing-open'));
    assert.ok(!body.includes('listing-private'));
  });

  it('anonymous lws+json items[] hides it too', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/lws+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(!body.includes('listing-private'));
  });

  it('the owner still sees both members', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' }, auth: 'alice' });
    const body = await r.text();
    assert.ok(body.includes('listing-open'));
    assert.ok(body.includes('listing-private'));
  });

  it('no oracle: the hidden member still answers 401/403 directly (not 404-scrubbed here — existence policy unchanged)', async () => {
    const r = await request(PRIV, { headers: { Accept: 'application/ld+json' } });
    assert.ok([401, 403].includes(r.status));
  });

  // Bare `.acl` (the container's OWN acl, not a `name.acl` sidecar for a
  // member) is Control-gated on the container it protects (authorized-
  // listing.js `e.name === '.acl'` branch) — untested until now. `.acl` is
  // an ALLOWED_DOTFILE for ldp:contains (src/ldp/container.js) but is
  // stripped from lws+json items[] regardless of WAC, so this only shows
  // up on the `application/ld+json` representation. `/alice/public/.acl`
  // already exists from pod creation (generatePublicFolderAcl: owner gets
  // Control, public gets Read only) — no extra fixture needed.
  it('CONTROL holder (owner) sees the container\'s own bare .acl in the listing', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' }, auth: 'alice' });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes(`${getBaseUrl()}/alice/public/.acl"`));
  });

  it('a non-CONTROL agent (anonymous, read-only) does not see the container\'s own bare .acl', async () => {
    const r = await request('/alice/public/', { headers: { Accept: 'application/ld+json' } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(!body.includes(`${getBaseUrl()}/alice/public/.acl"`));
  });

  // A member's `.meta` sidecar leaks the same class of thing the direct-GET
  // fix (db9cdaa/16530a1) closed, but on the LISTING surface: the `else`
  // branch in filterReadableEntries checks READ on `PRIV.meta`'s OWN path,
  // which walks up to the container's public-read default — not PRIV's own
  // tighter `.acl` — so the sidecar's bare presence in items[] leaks the
  // private member's name to an anonymous listing even though PRIV itself is
  // correctly hidden (the two tests above).
  it('a private member .meta is hidden from an anonymous listing, shown to the owner', async () => {
    const base = getBaseUrl();
    // PRIV already carries its own tighter .acl (see `before`); write its
    // .meta as owner.
    const metaRes = await request(`${PRIV}.meta`, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({ '@id': `${base}${PRIV}`,
        'http://purl.org/dc/terms/conformsTo': { '@id': 'https://example.org/prof/ex' } }),
    });
    assert.ok([200, 201, 204].includes(metaRes.status), `setup .meta PUT ${metaRes.status}`);
    const metaName = PRIV.split('/').pop() + '.meta';

    const anon = await request('/alice/public/', { headers: { Accept: 'application/lws+json' } });
    assertStatus(anon, 200);
    const anonBody = JSON.parse(await anon.text());
    assert.ok(!anonBody.items.some(i => i.id.endsWith(metaName)),
      `anon listing must not contain ${metaName}`);

    const owner = await request('/alice/public/', { headers: { Accept: 'application/lws+json' }, auth: 'alice' });
    assertStatus(owner, 200);
    const ownerBody = JSON.parse(await owner.text());
    assert.ok(ownerBody.items.some(i => i.id.endsWith(metaName)),
      `owner listing must contain ${metaName} (DT7)`);
  });
});
