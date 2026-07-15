// test/lws-navigator-parity.test.js
// Task 8 (fork): closes a routed Important finding from Task 6's review —
// HEAD of a container still evaluated the OLD, unscoped
// shouldServeMashlib(request, request.mashlibEnabled, 'application/ld+json')
// in handleHead's shared tail and predicted the legacy mashlib response
// shape (a '-html' ETag) while GET (Task 5/7) serves the navigator
// container/root view under a '-nav'/'-navroot' ETag. Fix mirrors GET's
// willServeNav/willServeRootView predicates so predict (HEAD) and serve
// (GET) can't drift.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const NOTE_TYPE = 'https://schema.org/TextDigitalDocument';

describe('lws: navigator container HEAD/GET parity (Task 8 routed fix)', () => {
  let base, CONTAINER;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('alice');
    CONTAINER = `${base}/alice/public/stuff/`;
    await request('/alice/public/stuff/pub.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown', Link: `<${NOTE_TYPE}>; rel="type"` },
      auth: 'alice',
      body: '# pub\n',
    });
  });
  after(stopTestServer);

  it('non-root container: HEAD and GET agree (same ETag, same content-type; navigator, not mashlib)', async () => {
    const getRes = await request(CONTAINER, { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(getRes, 200);
    const headRes = await request(CONTAINER, { method: 'HEAD', headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(headRes, 200);
    assert.equal(
      headRes.headers.get('content-type')?.split(';')[0],
      getRes.headers.get('content-type')?.split(';')[0],
      'HEAD and GET must agree on content-type',
    );
    assert.equal(headRes.headers.get('etag'), getRes.headers.get('etag'), 'HEAD and GET must agree on ETag');
    assert.match(headRes.headers.get('etag') || '', /-nav"$/,
      'HEAD must predict the navigator -nav ETag, not a mashlib -html ETag');
    assert.equal(await headRes.text(), '', 'HEAD must carry no body');
  });

  it('root, no ?view=nav: HEAD and GET agree (both the seeded landing page, unchanged)', async () => {
    const getRes = await request('/', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(getRes, 200);
    const headRes = await request('/', { method: 'HEAD', headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(headRes, 200);
    assert.equal(
      headRes.headers.get('content-type')?.split(';')[0],
      getRes.headers.get('content-type')?.split(';')[0],
    );
    assert.equal(headRes.headers.get('etag'), getRes.headers.get('etag'));
  });

  it('root, ?view=nav: HEAD and GET agree (both the navigator root/storage view, -navroot ETag)', async () => {
    const getRes = await request('/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(getRes, 200);
    const headRes = await request('/?view=nav', { method: 'HEAD', headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(headRes, 200);
    assert.equal(
      headRes.headers.get('content-type')?.split(';')[0],
      getRes.headers.get('content-type')?.split(';')[0],
    );
    assert.equal(headRes.headers.get('etag'), getRes.headers.get('etag'));
    assert.match(headRes.headers.get('etag') || '', /-navroot"$/, 'HEAD must predict the root-view -navroot ETag');
  });
});

// Brief's own scope (spec/task-8-brief.md): Vary: Accept once --lws media-
// type dispatch exists, plus pins that nothing serves mashlib under --lws
// and that --lws-off legacy behavior stays byte-identical. getVaryHeader
// (src/rdf/conneg.js) already threads request.lwsEnabled into every
// getAllHeaders-driven response — these pins were GREEN on first write
// (no getVaryHeader change needed); they lock the behavior in.
describe('lws: navigator parity pins — Vary: Accept + mashlib is truly gone', () => {
  let base;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('alice');
    await request('/alice/public/wiki/x.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown', Link: `<${NOTE_TYPE}>; rel="type"` },
      auth: 'alice',
      body: '# hello\n',
    });
  });
  after(stopTestServer);

  it('lws on: md resource browser GET carries Vary containing Accept', async () => {
    const r = await request('/alice/public/wiki/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assertStatus(r, 200);
    const vary = r.headers.get('vary') || '';
    assert.match(vary, /\bAccept\b/, 'Vary must include Accept once media-type dispatch exists under --lws');
  });

  it('lws on: nothing serves the mashlib wrapper — md file, container, root all navigator/entity-face, no marker', async () => {
    const file = await request('/alice/public/wiki/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    const container = await request('/alice/public/wiki/', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    const root = await request('/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    for (const r of [file, container, root]) {
      assertStatus(r, 200);
      const body = await r.text();
      assert.doesNotMatch(body, /databrowser|mashlib/i, 'no mashlib/databrowser marker anywhere under --lws');
    }
  });
});

describe('lws: navigator parity pins — lws OFF legacy byte-identity', () => {
  before(async () => {
    await startTestServer({ mashlibCdn: true });
    await createTestPod('carol4');
    await request('/carol4/public/x.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'carol4', body: '# x\n',
    });
  });
  after(stopTestServer);

  it('lws off: md file browser Accept -> mashlib wrapper served; Vary does NOT contain Accept-Profile', async () => {
    const r = await request('/carol4/public/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'carol4' });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /runDataBrowser|mashlib\.min\.js/, 'mashlib wrapper must still be served with --lws off');
    const vary = r.headers.get('vary') || '';
    assert.doesNotMatch(vary, /Accept-Profile/, 'legacy pin: --lws off must never advertise Accept-Profile in Vary');
  });
});
