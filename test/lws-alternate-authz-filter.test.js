// test/lws-alternate-authz-filter.test.js
// Integration test: Task 9 — no-oracle authz filter on advertised alternate
// representations (src/lws/representations.js filterReadableAlternates,
// wired via authorizedRepresentations in src/handlers/resource.js). Mirrors
// the harness in test/lws-profile-conneg-get.test.js / lws-linkset-
// representations.test.js, but runs WITHOUT `public: true` — real WAC must
// be enforced for this to prove anything, since the filter's checkAccess()
// call is independent of the server's blanket public-mode bypass.
//
// Resources live under /alice/public/ so the DEFAULT representation
// inherits the pod's own public-read default ACL (generatePublicFolderAcl,
// written at pod-creation time — see src/handlers/container.js). The
// ALTERNATE representation gets its own resource-level .acl
// (generatePrivateAcl: owner-only, no public grant), which overrides that
// inherited default per findApplicableAcl's resource-ACL-first lookup.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';
const RES_PATH = '/alice/public/mem-a.md';
const ALT_PATH = '/alice/public/mem-a-private.jsonld';
const PUBLIC_PROFILE = 'https://profiles.example/public-content';
const PRIVATE_PROFILE = 'https://profiles.example/private-alt';

describe('No-oracle authz filter on advertised alternates (Task 9)', () => {
  let RES, ALT;

  before(async () => {
    // Real WAC (no `public: true`) — the filter's checkAccess() call must
    // be exercised against actual ACLs, not the blanket bypass.
    await startTestServer({ lws: true });
    const alice = await createTestPod('alice');
    const base = getBaseUrl();
    RES = `${base}${RES_PATH}`;
    ALT = `${base}${ALT_PATH}`;

    // /alice/public/ already has a default recursive public-read ACL from
    // pod creation, so RES_PATH is publicly readable without any extra setup.
    await request(RES_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: '# hello',
      auth: 'alice',
    });
    await request(ALT_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({ '@id': ALT, note: 'private alternate' }),
      auth: 'alice',
    });

    // Owner-only ACL on the alternate — overrides the inherited public
    // default (resource ACL wins over container default, see
    // src/wac/checker.js findApplicableAcl).
    const privateAcl = generatePrivateAcl(ALT, alice.webId, false);
    const aclRes = await request(`${ALT_PATH}.acl`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: serializeAcl(privateAcl),
      auth: 'alice',
    });
    assertStatus(aclRes, 201, 'setup: private ACL on the alternate must be written');

    // Client-managed .meta declaring a public default + the private alternate.
    await request(`${RES_PATH}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { altr: ALTR, dct: DCT },
        '@id': RES,
        'altr:hasDefaultRepresentation': {
          '@id': RES, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': PUBLIC_PROFILE },
        },
        'altr:hasRepresentation': {
          '@id': ALT, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': PRIVATE_PROFILE },
        },
      }),
      auth: 'alice',
    });
  });

  after(async () => { await stopTestServer(); });

  it('anonymous: linkset omits the unreadable alternate (canonical still present)', async () => {
    const res = await request(RES_PATH, { headers: { Accept: 'application/linkset+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    const link = body.linkset[0];
    assert.deepEqual(link.canonical, [{ href: RES, type: 'text/markdown', formats: PUBLIC_PROFILE }]);
    assert.equal('alternate' in link, false, 'private alternate must not appear in the linkset at all');
  });

  it('anonymous: Accept-Profile for the unreadable alternate → 406 (no-oracle, not 303)', async () => {
    const res = await request(RES_PATH, {
      headers: { 'Accept-Profile': `<${PRIVATE_PROFILE}>` },
      redirect: 'manual',
    });
    assertStatus(res, 406);
  });

  it('authenticated owner: linkset includes the alternate (per-client, not a blanket drop)', async () => {
    const res = await request(RES_PATH, {
      headers: { Accept: 'application/linkset+json' },
      auth: 'alice',
    });
    assertStatus(res, 200);
    const body = await res.json();
    const link = body.linkset[0];
    assert.deepEqual(link.alternate, [{ href: ALT, type: 'application/ld+json', formats: PRIVATE_PROFILE }]);
  });

  it('authenticated owner: Accept-Profile for the alternate → 303 redirect', async () => {
    const res = await request(RES_PATH, {
      headers: { 'Accept-Profile': `<${PRIVATE_PROFILE}>` },
      auth: 'alice',
      redirect: 'manual',
    });
    assertStatus(res, 303);
    assert.equal(res.headers.get('location'), ALT);
  });
});
