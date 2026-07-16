// test/lws-navigator-root.test.js
// Task 7 (fork, spec 2026-07-15): the navigator's root/storage view —
// renders the LWS storage description (services, capabilities, uriSpace
// prefixes — the same buildStorageDescriptionFor the per-storage
// `/<pod>/lws-storage` route serves) beside the WAC-filtered top-level
// listing, instead of Task 5's generic container view. Reached only via the
// explicit ?view=nav escape — the seeded index.html shadow keeps serving
// plain GET / unchanged (deviation (4)).
//
// Task A10 (multi-tenant round) moved this view from the SERVER root
// (`/?view=nav`) to each STORAGE's own root (`/<pod>/?view=nav`) — the
// server root is now a WAC-filtered roster of every storage the pod hosts
// (renderServerIndexView, test/lws-navigator-multitenant.test.js). The
// per-storage-view assertions below were re-pointed at `/alice/?view=nav`
// accordingly; the anon-vs-owner visibility suite stays at `/?view=nav`
// (it's now testing the roster's own WAC filtering, which is the same
// underlying guarantee — listVisibleStorageRoots — under a new name).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, getPodToken, assertStatus,
} from './helpers.js';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const CONFIG_PATH = '/alice/profiles/pod-config.jsonld';

describe('lws: navigator root/storage view (Task 7)', () => {
  let base, tok;

  before(async () => {
    await startTestServer({ lws: true, mashlibCdn: true, lwsConfig: CONFIG_PATH });
    base = getBaseUrl();
    await createTestPod('alice');
    tok = getPodToken('alice');
    // pod-config declaring a uriSpace — the root view must surface its
    // recognition prefix (same fixture shape as
    // test/lws-referent-resolver.test.js's "303 referent resolver" suite).
    await request(CONFIG_PATH, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: JSON.stringify({ uriSpaces: [{ pathPrefix: '/id/', container: '/alice/concepts/' }] }),
    });
  });
  after(stopTestServer);

  // Anonymous: createPodStructure's root ACL (generateOwnerAcl) grants
  // `#public` Read on the pod container's OWN accessTo (a pod's existence
  // is discoverable) even though descendants stay private via its owner-only
  // `acl:default` — so /alice/ itself is visible to anon here. The
  // negative case (a top-level container with no public grant at all) is
  // covered by the private-visibility suite below.
  it('browser Accept + /alice/?view=nav: 200 html, Storage heading, a service name, the configured uriSpace prefix, top-level container name', async () => {
    const r = await request('/alice/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /Storage/, 'must render the Storage heading');
    assert.match(body, /TypeIndexService/, 'must list a service name');
    assert.ok(body.includes(`${base}/id/`), 'must surface the configured uriSpace prefix');
    assert.ok(body.includes(`${base}/alice/public/`), 'must list alice\'s own top-level containers (public-read)');
    assert.match(body, /\/alice\/lws-storage/, 'must link this storage\'s own machine view');
  });

  it('GET / browser Accept (no ?view=nav): the seeded index.html landing, unchanged', async () => {
    const r = await request('/', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /Your JSS Solid pod is running/, 'seeded server-root landing must still serve');
    assert.doesNotMatch(body, /<h2>Storage<\/h2>/, 'must not render the nav root view');
  });

  it('GET /?view=nav: the server index roster (not a single storage\'s view), links to /alice/?view=nav', async () => {
    const r = await request('/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.doesNotMatch(body, /<h2>Storage<\/h2>/, 'the server index is a roster, not a single storage\'s view');
    assert.ok(body.includes(`${base}/alice/?view=nav`), 'must link alice\'s own storage view');
  });
});

// 4th case (brief: "consider"): anon vs owner root view differs only by
// WAC-visible containers. A freshly created pod's OWN container entry is
// public by design (see the comment above) — so this needs a top-level
// container with NO public grant at all (generatePrivateAcl, owner-only,
// no `#public` block) to exercise the negative case; a plain createTestPod
// fixture can't distinguish anon from owner at the top level.
describe('lws: navigator root view — anon vs owner top-level visibility', () => {
  let base, tok, webId;
  before(async () => {
    await startTestServer({ lws: true, mashlibCdn: true });
    base = getBaseUrl();
    const created = await createTestPod('carol');
    tok = getPodToken('carol');
    webId = created.webId;
    const { generatePrivateAcl, serializeAcl } = await import('../src/wac/parser.js');
    const acl = generatePrivateAcl(`${base}/carol/`, webId, true);
    const res = await request('/carol/.acl', {
      method: 'PUT',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/ld+json' },
      body: serializeAcl(acl),
    });
    assertStatus(res, 204, 'setup: overriding /carol/.acl to fully-private must succeed');
  });
  after(stopTestServer);

  it('anon ?view=nav: the fully-private top-level container is filtered out', async () => {
    const r = await request('/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(!body.includes(`${base}/carol/`), 'private top-level container must be hidden from anon');
  });

  it('owner ?view=nav: still sees its own top-level container', async () => {
    const r = await request('/?view=nav', { headers: { Accept: BROWSER_ACCEPT }, auth: 'carol' });
    assertStatus(r, 200);
    const body = await r.text();
    assert.ok(body.includes(`${base}/carol/`), 'owner must see its own top-level container');
  });
});

describe('lws: navigator root view — ?view=nav is inert without --lws', () => {
  before(async () => {
    await startTestServer({ mashlibCdn: true });
  });
  after(stopTestServer);

  it('?view=nav on a non-lws pod leaves GET / unchanged (legacy behavior, param ignored)', async () => {
    const r = await request('/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /Your JSS Solid pod is running/, 'legacy landing unchanged — query param inert');
    assert.doesNotMatch(body, /<h2>Storage<\/h2>/, 'must not render the nav root view');
  });
});

// Review fix (root-view ETag key): the root storage view (`/?view=nav`) and
// the plain navigator container view (`GET /` when the seeded index.html is
// absent — operator-reachable since seeding is skip-if-exists, e.g. a fresh
// DATA_ROOT the operator never wrote an index.html into) shared the
// identical predictive '-nav' listing ETag (stats.etag + labeledListingType
// + visKey only — blind to which rendering branch would actually serve)
// despite producing different bodies, so an If-None-Match minted from one
// could bogus-304 the other.
//
// Task A10 widened this to a THREE-way disambiguation: `/` (generic
// container view, unchanged), `/?view=nav` (now the server-index roster,
// not a single storage's view), and `/alice/?view=nav` (the per-storage
// root view Task 7 originally described) each mint their own '-nav' /
// '-navindex' / '-navroot' ETag variant — none of the three may cross-304
// another.
describe('lws: navigator root view vs container view — ETag disambiguation (review fix)', () => {
  before(async () => {
    await startTestServer({ lws: true, mashlibCdn: true });
    await createTestPod('alice');
    // Remove the seeded root index.html so plain GET / falls through past
    // the deviation-(4) landing-page shadow into the navigator's generic
    // container view (Task 5) instead — the operator-reachable case this
    // finding is about.
    await fs.remove('./data/index.html');
  });
  after(stopTestServer);

  it('/ (container view), /?view=nav (server index), /alice/?view=nav (storage view) mint distinct ETags that can never cross-304', async () => {
    const containerRes = await request('/', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(containerRes, 200);
    const containerBody = await containerRes.text();
    assert.doesNotMatch(containerBody, /<h2>Storage<\/h2>/, 'plain GET / (no seeded index.html) must render the container view, not a storage view');
    const etagA = containerRes.headers.get('etag');
    assert.ok(etagA, 'container view must carry an ETag');

    const indexRes = await request('/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(indexRes, 200);
    const indexBody = await indexRes.text();
    assert.doesNotMatch(indexBody, /<h2>Storage<\/h2>/, 'GET /?view=nav must render the server-index roster, not a single storage\'s view');
    const etagB = indexRes.headers.get('etag');
    assert.ok(etagB, 'server-index view must carry an ETag');

    const rootRes = await request('/alice/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(rootRes, 200);
    const rootBody = await rootRes.text();
    assert.match(rootBody, /<h2>Storage<\/h2>/, 'GET /alice/?view=nav must render alice\'s own storage view');
    const etagC = rootRes.headers.get('etag');
    assert.ok(etagC, 'storage view must carry an ETag');

    assert.notEqual(etagA, etagB, 'container-view and server-index ETags must not collide');
    assert.notEqual(etagA, etagC, 'container-view and storage-view ETags must not collide');
    assert.notEqual(etagB, etagC, 'server-index and storage-view ETags must not collide');

    const crossCheck = await request('/alice/?view=nav', {
      headers: { Accept: BROWSER_ACCEPT, 'If-None-Match': etagA },
    });
    assertStatus(crossCheck, 200, 'the container-view ETag must NOT validate a storage-view conditional GET (no bogus 304)');

    const crossCheck2 = await request('/alice/?view=nav', {
      headers: { Accept: BROWSER_ACCEPT, 'If-None-Match': etagB },
    });
    assertStatus(crossCheck2, 200, 'the server-index ETag must NOT validate a storage-view conditional GET (no bogus 304)');

    const ownCheck = await request('/alice/?view=nav', {
      headers: { Accept: BROWSER_ACCEPT, 'If-None-Match': etagC },
    });
    assertStatus(ownCheck, 304, 'the storage view must 304 against its own ETag');
  });
});
