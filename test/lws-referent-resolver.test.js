// Referent identity & discovery (2026-07-13): a minted subject-IRI name
// (e.g. /id/{slug}) has no stored resource, so it 404s today. resolveReferent
// reads a pathPrefix->container plane-mapping from pod-config and the
// !stats seam in handleGet/handleHead 303-redirects to the backing resource.
// no-oracle: 404-hide when the target is missing or the requester can't read it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, createTestPod, getPodToken, getBaseUrl, request } from './helpers.js';
import { resolveReferent } from '../src/lws/referent-resolver.js';

describe('resolveReferent (pure)', () => {
  const spaces = [{ pathPrefix: '/id/', container: '/alice/concepts/' }];
  it('maps a flat minted name to its container', () => {
    assert.equal(resolveReferent('/id/alpha', spaces), '/alice/concepts/alpha');
  });
  it('ignores nested / empty names and non-matching prefixes', () => {
    assert.equal(resolveReferent('/id/a/b', spaces), null);
    assert.equal(resolveReferent('/id/', spaces), null);
    assert.equal(resolveReferent('/other/x', spaces), null);
  });
});

describe('303 referent resolver (live)', () => {
  let base, tok;
  before(async () => {
    await startTestServer({ lws: true, lwsConfig: '/alice/profiles/pod-config.jsonld' });
    base = getBaseUrl(); await createTestPod('alice'); tok = getPodToken('alice');
    // pod-config declaring the plane-mapping
    await request(`${base}/alice/profiles/pod-config.jsonld`, { method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: JSON.stringify({ profileIndex: '/alice/profiles/index.jsonld', void: '/alice/profiles/void.jsonld',
        uriSpaces: [{ pathPrefix: '/id/', container: '/alice/concepts/' }] }) });
    // a real, PUBLIC-READ target the name resolves to
    await request(`${base}/alice/concepts/alpha`, { method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: JSON.stringify({ '@id': `${base}/id/alpha#it`, 'http://purl.org/dc/terms/title': 'Alpha' }) });
    const { generatePublicReadAcl, serializeAcl } = await import('../src/wac/parser.js');
    await request(`${base}/alice/concepts/alpha.acl`, { method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: serializeAcl(generatePublicReadAcl(`${base}/alice/concepts/alpha`)) });
    // a real, PRIVATE (owner-only ACL, no public grant) target — the no-oracle hide case
    await request(`${base}/alice/concepts/secret`, { method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: JSON.stringify({ '@id': `${base}/id/secret#it`, 'http://purl.org/dc/terms/title': 'Secret' }) });
  });
  after(stopTestServer);

  it('303s a minted name to the public target (anonymous)', async () => {
    const r = await request(`${base}/id/alpha`, { redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `${base}/alice/concepts/alpha`);
    assert.match(r.headers.get('link') || '', /rel="canonical"/);
  });
  it('404-hides a name with no backing target', async () => {
    const r = await request(`${base}/id/missing`, { redirect: 'manual' });
    assert.equal(r.status, 404);
  });
  it('no-oracle: 404-hides a name whose target exists but is not readable (anonymous)', async () => {
    const r = await request(`${base}/id/secret`, { redirect: 'manual' });
    assert.equal(r.status, 404);
  });
  it('HEAD mirrors GET: 303 to the public target, bodyless', async () => {
    const r = await request(`${base}/id/alpha`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `${base}/alice/concepts/alpha`);
    const body = await r.text();
    assert.equal(body, '');
  });
});

describe('303 referent resolver (--lws off)', () => {
  let base, tok;
  before(async () => {
    await startTestServer({ lws: false });
    base = getBaseUrl(); await createTestPod('alice'); tok = getPodToken('alice');
    await request(`${base}/alice/concepts/alpha`, { method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: JSON.stringify({ '@id': `${base}/id/alpha#it`, 'http://purl.org/dc/terms/title': 'Alpha' }) });
  });
  after(stopTestServer);

  it('resolver is dormant without --lws: byte-identical to pre-resolver baseline (never 303)', async () => {
    // /id/ is a root-level path with no covering ACL, so the server's
    // ordinary WAC gate (unrelated to this resolver, unchanged by it) denies
    // it 401 on both pristine HEAD and this branch when --lws is off — the
    // resolver's own onRequest/preHandler/handler hooks are all gated on
    // request.lwsEnabled, so none of them run here. The one invariant this
    // negative control actually needs is "never 303" (never masquerades as
    // a resolved referent); 401 here is the pre-existing, unmodified
    // behavior, not something this task introduced.
    const r = await request(`${base}/id/alpha`, { redirect: 'manual' });
    assert.equal(r.status, 401);
  });
});
