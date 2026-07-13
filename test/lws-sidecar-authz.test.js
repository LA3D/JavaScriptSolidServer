// test/lws-sidecar-authz.test.js
// C1 (whole-branch review, 2026-07-13): `.lwstypes`/`.lwsprov` are System-
// Managed sidecars that leak the SUBJECT's rdf:type / validating profile.
// They are directly addressable (the dotfile guard only rejects segments
// STARTING with '.', and `secret.jsonld.lwstypes` doesn't), and the blanket
// WAC check resolved an ACL by walking UP from the sidecar's own path
// (findApplicableAcl in src/wac/checker.js) — landing on the CONTAINER
// default, never the subject's own (possibly tighter) `.acl`. So a private
// resource in an otherwise-public container had a publicly-readable
// `.lwstypes`/`.lwsprov` even though the resource itself 403s.
//
// Fix (src/auth/middleware.js authorizeSidecarAccess): GET/HEAD of
// `*.lwstypes`/`*.lwsprov` now requires acl:Read on the STRIPPED SUBJECT —
// mirrors the existing `*.acl` carve-out (authorizeAclAccess), READ instead
// of Control.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const OPEN = '/alice/public/sidecar-open.jsonld';   // stays public (container default)
const PRIV = '/alice/public/sidecar-secret.jsonld';  // tighter own ACL

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';
const DCT_CONFORMS = 'http://purl.org/dc/terms/conformsTo';
const PROFILE_URI = 'https://example.org/prof/ex-sidecar';

// Trivial always-pass shape: targets ex:Thing with no property constraints,
// so admission resolves 'admit' (SHACL genuinely ran) — the precondition for
// a `.lwsprov` sidecar to be written at all (see type-metadata.js).
const ALWAYS_PASS_SHAPE = JSON.stringify({
  '@context': { sh: 'http://www.w3.org/ns/shacl#', ex: 'http://ex/' },
  '@id': 'http://ex/AlwaysPassShapeSidecar',
  '@type': 'sh:NodeShape',
  'sh:targetClass': { '@id': 'http://ex/Thing' },
});

function typedBody(base, path) {
  return JSON.stringify({
    '@id': `${base}${path}#it`,
    '@type': 'https://example.org/ex#Thing',
    'http://purl.org/dc/terms/title': 'sidecar-authz fixture',
  });
}

describe('.lwstypes/.lwsprov sidecars require READ-on-subject (C1)', () => {
  let alice, base;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    alice = await createTestPod('alice');
    base = getBaseUrl();

    // Public member — no resource-specific .acl, inherits the /public/
    // container's public-read default (generatePublicFolderAcl).
    const openPut = await request(OPEN, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: typedBody(base, OPEN),
    });
    assert.ok([200, 201, 204].includes(openPut.status), `open PUT ${openPut.status}`);

    // Private member — TIGHTER own ACL overrides the container's public-read
    // default (resource ACL wins over container default — findApplicableAcl).
    const privPut = await request(PRIV, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: typedBody(base, PRIV),
    });
    assert.ok([200, 201, 204].includes(privPut.status), `priv PUT ${privPut.status}`);

    const aclRes = await request(`${PRIV}.acl`, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: serializeAcl(generatePrivateAcl(`${base}${PRIV}`, alice.webId, false)),
    });
    assert.ok([200, 201, 204].includes(aclRes.status), `priv .acl PUT ${aclRes.status}`);

    // Governed member — /public/ declares describedby+conformsTo so an
    // admitted (SHACL-validated) member earns a `.lwsprov` sidecar too.
    const shapePut = await request('/alice/shapes/AlwaysPassSidecar', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: ALWAYS_PASS_SHAPE,
    });
    assert.ok(shapePut.ok, `shape PUT ${shapePut.status}`);

    const metaPut = await request('/alice/public/.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({
        '@id': `${base}/alice/public/`,
        [DESCRIBEDBY]: { '@id': `${base}/alice/shapes/AlwaysPassSidecar` },
        [DCT_CONFORMS]: { '@id': PROFILE_URI },
      }),
    });
    assert.ok(metaPut.ok, `.meta PUT ${metaPut.status}`);

    // Re-PUT the private member so it's admitted under the now-governed
    // container (earns .lwsprov), then re-tighten its .acl (the .meta PUT
    // above didn't touch it, but re-asserting keeps the fixture explicit).
    const govPut = await request(PRIV, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({
        '@id': `${base}${PRIV}#it`,
        '@type': 'http://ex/Thing',
        'http://purl.org/dc/terms/title': 'sidecar-authz fixture (governed)',
      }),
    });
    assert.ok([200, 201, 204].includes(govPut.status), `governed re-PUT ${govPut.status}`);
    const aclRes2 = await request(`${PRIV}.acl`, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: serializeAcl(generatePrivateAcl(`${base}${PRIV}`, alice.webId, false)),
    });
    assert.ok([200, 201, 204].includes(aclRes2.status), `priv .acl re-PUT ${aclRes2.status}`);
  });
  after(async () => { await stopTestServer(); });

  it('sanity: the private resource itself 401/403s anonymously', async () => {
    const r = await request(PRIV);
    assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}`);
  });

  it('LEAK CLOSED: anonymous GET of the private resource\'s .lwstypes is not 200', async () => {
    const r = await request(`${PRIV}.lwstypes`);
    assert.ok([401, 403, 404].includes(r.status), `expected 401/403/404, got ${r.status}: ${await r.text()}`);
  });

  it('LEAK CLOSED: anonymous HEAD of the private resource\'s .lwstypes is not 200', async () => {
    const r = await request(`${PRIV}.lwstypes`, { method: 'HEAD' });
    assert.ok([401, 403, 404].includes(r.status), `expected 401/403/404, got ${r.status}`);
  });

  it('LEAK CLOSED: anonymous GET of the governed private member\'s .lwsprov is not 200', async () => {
    const r = await request(`${PRIV}.lwsprov`);
    assert.ok([401, 403, 404].includes(r.status), `expected 401/403/404, got ${r.status}: ${await r.text()}`);
  });

  it('PRESERVED: the owner still GETs the private resource\'s .lwstypes', async () => {
    const r = await request(`${PRIV}.lwstypes`, { auth: 'alice' });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = await r.json();
    // The governed re-PUT in before() overwrote PRIV's body with @type
    // http://ex/Thing (to match the always-pass shape's targetClass).
    assert.ok(Array.isArray(body) && body.includes('http://ex/Thing'),
      `expected the declared type in the owner's .lwstypes body: ${JSON.stringify(body)}`);
  });

  it('PRESERVED: the owner still GETs the governed private member\'s .lwsprov', async () => {
    const r = await request(`${PRIV}.lwsprov`, { auth: 'alice' });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = await r.json();
    assert.ok(body.conformsTo?.includes(PROFILE_URI), `expected earned conformsTo: ${JSON.stringify(body)}`);
  });

  it('NO OVER-BLOCKING: a public resource\'s .lwstypes stays anonymously readable', async () => {
    const r = await request(`${OPEN}.lwstypes`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = await r.json();
    assert.ok(Array.isArray(body) && body.includes('https://example.org/ex#Thing'));
  });
});
