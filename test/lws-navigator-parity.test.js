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
