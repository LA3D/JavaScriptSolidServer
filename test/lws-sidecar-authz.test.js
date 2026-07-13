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
//
// `.meta` extension (same day, live-triage-confirmed): the client-managed
// `.meta` sidecar leaks the same class of thing — a private member's own
// governance metadata (dct:conformsTo/powder:describedby) plus its
// existence — through the identical hole. GET/HEAD of `*.meta` now routes
// through the SAME authorizeSidecarAccess (READ-on-stripped-subject);
// PUT/PATCH/DELETE of `.meta` are untouched (still WRITE via the blanket
// check — `.meta` is legitimately client-writable, unlike `.lwstypes`/
// `.lwsprov`). The stripped-subject computation is suffix-agnostic: a
// CONTAINER's own bare `.meta` (`/foo/.meta` → strip → `/foo/`) checks READ
// on the CONTAINER, preserving the public governance up-walk; a MEMBER's
// `.meta` (`/foo/bar.meta` → strip → `/foo/bar`) checks READ on the MEMBER,
// closing the leak.
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

describe('.lwstypes/.lwsprov/.meta sidecars require READ-on-subject (C1)', () => {
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

    // `.meta` extension fixtures: a MEMBER-level `.meta` on each of PRIV
    // (tighter own .acl) and OPEN (public, container default) — distinct
    // from the CONTAINER's own bare `.meta` PUT above (which already
    // carries describedby+conformsTo and is reused as-is for the up-walk
    // case). Owner-authored via alice; write.js resolves `.meta` writes
    // through the container's default ACL (not the stripped-subject rule
    // — that's GET/HEAD-only), so these PUTs succeed regardless of PRIV's
    // tighter own .acl.
    const privMetaPut = await request(`${PRIV}.meta`, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({
        '@id': `${base}${PRIV}`,
        [DESCRIBEDBY]: { '@id': `${base}/alice/shapes/AlwaysPassSidecar` },
        [DCT_CONFORMS]: { '@id': PROFILE_URI },
      }),
    });
    assert.ok(privMetaPut.ok, `priv .meta PUT ${privMetaPut.status}`);

    const openMetaPut = await request(`${OPEN}.meta`, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: JSON.stringify({
        '@id': `${base}${OPEN}`,
        [DCT_CONFORMS]: { '@id': PROFILE_URI },
      }),
    });
    assert.ok(openMetaPut.ok, `open .meta PUT ${openMetaPut.status}`);
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

  // --- .meta extension (live-triage-confirmed leak, 2026-07-13) ---

  it('LEAK CLOSED: anonymous GET of the private member\'s .meta is not 200', async () => {
    const r = await request(`${PRIV}.meta`);
    assert.ok([401, 403, 404].includes(r.status), `expected 401/403/404, got ${r.status}: ${await r.text()}`);
  });

  it('LEAK CLOSED: anonymous HEAD of the private member\'s .meta is not 200', async () => {
    const r = await request(`${PRIV}.meta`, { method: 'HEAD' });
    assert.ok([401, 403, 404].includes(r.status), `expected 401/403/404, got ${r.status}`);
  });

  it('NO OVER-BLOCKING: a public member\'s .meta stays anonymously readable', async () => {
    const r = await request(`${OPEN}.meta`);
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = await r.json();
    assert.equal(body[DCT_CONFORMS]?.['@id'], PROFILE_URI, `expected conformsTo in body: ${JSON.stringify(body)}`);
  });

  it('UP-WALK PRESERVED: a public container\'s own .meta stays anonymously readable', async () => {
    // /alice/public/.meta was PUT in before() with describedby+conformsTo.
    // Stripping '.meta' from '/alice/public/.meta' yields the CONTAINER
    // path '/alice/public/' (trailing slash) — READ is checked against the
    // container, which is public-read by default, so this must stay 200.
    // This is the case the fix must NOT break: governance discovery for a
    // cold agent walking up from a member to its container's .meta.
    const r = await request('/alice/public/.meta');
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = await r.json();
    assert.equal(body[DCT_CONFORMS]?.['@id'], PROFILE_URI, `expected conformsTo in body: ${JSON.stringify(body)}`);
    assert.equal(body[DESCRIBEDBY]?.['@id'], `${base}/alice/shapes/AlwaysPassSidecar`,
      `expected describedby in body: ${JSON.stringify(body)}`);
  });

  it('PRESERVED: the owner still GETs the private member\'s .meta', async () => {
    const r = await request(`${PRIV}.meta`, { auth: 'alice' });
    assert.equal(r.status, 200, `expected 200, got ${r.status}`);
    const body = await r.json();
    assert.equal(body[DCT_CONFORMS]?.['@id'], PROFILE_URI, `expected conformsTo in body: ${JSON.stringify(body)}`);
  });

  it('sanity: .acl stays CONTROL-protected (unchanged by the .meta fix)', async () => {
    const r = await request(`${PRIV}.acl`);
    assert.ok([401, 403].includes(r.status), `expected 401/403, got ${r.status}: ${await r.text()}`);
  });
});
