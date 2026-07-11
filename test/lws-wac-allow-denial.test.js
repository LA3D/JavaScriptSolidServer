// test/lws-wac-allow-denial.test.js
// F1 (probe-#6, spec §6): WAC-Allow on a `.acl` response must describe the
// ACL resource itself (control-gated), not the protected resource it guards.
// A 401 wearing the protected resource's public="read" is retry-loop bait
// for WAC-aware clients. --lws-gated (2026-07-11 Chuck decision): the
// --lws-off path keeps the upstream (misleading) header byte-identical.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl,
} from './helpers.js';
import { generatePublicFolderAcl, serializeAcl } from '../src/wac/parser.js';

const CONTAINER = '/alice/f1/';
const MARKER = `${CONTAINER}marker.jsonld`;

// Grant public-read + owner-control on the container, defaulted to children
// — the probe-#6 condition: the PROTECTED resource has public read, no
// public control.
async function grantPublicReadNoControl(base, alice) {
  const put = await request(MARKER, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    auth: 'alice',
    body: JSON.stringify({ '@id': `${base}${MARKER}`, note: 'marker' }),
  });
  assert.ok([200, 201, 204].includes(put.status));

  const aclRes = await request(`${CONTAINER}.acl`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    auth: 'alice',
    body: serializeAcl(generatePublicFolderAcl(`${base}${CONTAINER}`, alice.webId)),
  });
  assert.ok([200, 201, 204].includes(aclRes.status));
}

describe('wac-allow on .acl denial is honest (F1) — --lws on', () => {
  let alice, base;
  before(async () => {
    await startTestServer({ lws: true });
    alice = await createTestPod('alice');
    base = getBaseUrl();
    await grantPublicReadNoControl(base, alice);
  });
  after(async () => { await stopTestServer(); });

  it('anonymous GET /alice/f1/.acl → 401 with empty WAC-Allow grants (not the protected resource\'s public="read")', async () => {
    const r = await request(`${CONTAINER}.acl`);
    assert.equal(r.status, 401);
    const wa = r.headers.get('wac-allow') || '';
    assert.match(wa, /user=""/);
    assert.match(wa, /public=""/);
  });

  it('owner GET /alice/f1/.acl → 200 (control holds) with non-empty user modes', async () => {
    const r = await request(`${CONTAINER}.acl`, { auth: 'alice' });
    assert.equal(r.status, 200);
    const wa = r.headers.get('wac-allow') || '';
    assert.match(wa, /user="read write"/);
    assert.match(wa, /public=""/);
  });
});

describe('wac-allow on .acl denial — --lws off (upstream byte-identity, negative control)', () => {
  let alice, base;
  before(async () => {
    await startTestServer({ lws: false });
    alice = await createTestPod('alice');
    base = getBaseUrl();
    await grantPublicReadNoControl(base, alice);
  });
  after(async () => { await stopTestServer(); });

  it('anonymous GET /alice/f1/.acl → 401 with the UPSTREAM header (protected resource\'s public="read") — byte-identical, unchanged', async () => {
    const r = await request(`${CONTAINER}.acl`);
    assert.equal(r.status, 401);
    const wa = r.headers.get('wac-allow') || '';
    assert.equal(wa, 'user="read", public="read"');
  });
});
