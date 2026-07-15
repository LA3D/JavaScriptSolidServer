// test/lws-navigator-entity.test.js
// Task 6 (fork, spec 2026-07-15): the navigator's generic entity face — a
// server-rendered HTML view for FILE resources with no declared text/html
// alternate, replacing mashlib for files once --lws is on. Mirrors
// test/lws-navigator-container.test.js (Task 5) and
// test/lws-html-dispatch.test.js (Task 4, whose declared-alternate fixture
// shape this reuses for the ?view=nav-override case).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl,
} from './helpers.js';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const NOTE_TYPE = 'https://schema.org/TextDigitalDocument';
const MD_BODY = '# Hello\n\n<script>alert(1)</script>\n';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';

function repMeta(id, alt) {
  return JSON.stringify({
    '@context': { altr: ALTR, dct: DCT },
    '@id': id,
    'altr:hasDefaultRepresentation': { '@id': id, 'dct:format': 'text/markdown' },
    'altr:hasRepresentation': { '@id': alt, 'dct:format': 'text/html' },
  });
}

describe('lws: navigator generic entity face (Task 6)', () => {
  let base, RES, RES2, FACE2;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('alice');
    RES = `${base}/alice/public/wiki/x.md`;
    RES2 = `${base}/alice/public/wiki/y.md`;
    FACE2 = `${base}/alice/public/wiki/y.md.html`;

    // x.md: typed via Link rel=type (populates .lwstypes), no .meta →
    // no declared alternate, so browser GETs land on the entity face.
    await request('/alice/public/wiki/x.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown', Link: `<${NOTE_TYPE}>; rel="type"` },
      auth: 'alice',
      body: MD_BODY,
    });

    // y.md: HAS a declared text/html alternate (Task 4 fixture shape) — the
    // face-dispatch 303 wins UNLESS ?view=nav opts out to the entity view.
    await request('/alice/public/wiki/y.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'alice', body: '# y\n',
    });
    await request('/alice/public/wiki/y.md.html', {
      method: 'PUT', headers: { 'Content-Type': 'text/html' }, auth: 'alice', body: '<p>y</p>',
    });
    await request('/alice/public/wiki/y.md.meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
      body: repMeta(RES2, FACE2),
    });
  });
  after(stopTestServer);

  it('1. browser GET of a typed file with no declared face -> entity view: type badge, machine-view links, escaped excerpt, no mashlib marker', async () => {
    const r = await request('/alice/public/wiki/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /TextDigitalDocument/, 'declared-type localName badge must render');
    assert.match(body, new RegExp(`href="${RES}"[^<]*>raw<`), 'machine view must link the raw URL');
    assert.doesNotMatch(body, /databrowser/i, 'must not carry the mashlib marker');
  });

  it('4. excerpt escaping: <script> in the stored body renders escaped inside <pre>', async () => {
    const r = await request('/alice/public/wiki/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /<pre[^>]*>[\s\S]*&lt;script&gt;alert\(1\)&lt;\/script&gt;[\s\S]*<\/pre>/,
      'excerpt must render the stored <script> tag escaped inside <pre>');
    assert.doesNotMatch(body, /<pre[^>]*>[\s\S]*<script>alert/, 'the excerpt must never carry a live <script> tag');
  });

  it('2. ?view=nav on a resource WITH a declared html alternate -> entity view, not 303 (dispatch override)', async () => {
    const r = await request('/alice/public/wiki/y.md?view=nav', {
      headers: { Accept: BROWSER_ACCEPT }, auth: 'alice', redirect: 'manual',
    });
    assert.notEqual(r.status, 303, '?view=nav must opt out of the face-dispatch redirect');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.doesNotMatch(body, /<p>y<\/p>/, 'the declared alternate\'s own body must not be served');
  });

  it('3. Accept: text/markdown -> raw bytes unchanged (no entity face)', async () => {
    const r = await request('/alice/public/wiki/x.md', { headers: { Accept: 'text/markdown' }, auth: 'alice' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/markdown/);
    const body = await r.text();
    assert.equal(body, MD_BODY, 'a non-browser Accept must get the stored bytes verbatim');
  });

  it('6. ETag: entity-face response carries a -nav variant, distinct from the raw-bytes ETag', async () => {
    const navRes = await request('/alice/public/wiki/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    const rawRes = await request('/alice/public/wiki/x.md', { headers: { Accept: 'text/markdown' }, auth: 'alice' });
    assert.equal(navRes.status, 200);
    assert.equal(rawRes.status, 200);
    const navEtag = navRes.headers.get('etag');
    const rawEtag = rawRes.headers.get('etag');
    assert.ok(navEtag, 'entity-face response must carry an ETag');
    assert.ok(rawEtag, 'raw-bytes response must carry an ETag');
    assert.notEqual(navEtag, rawEtag);
    assert.match(navEtag, /-nav"$/, 'entity-face ETag must carry a -nav variant suffix');
  });

  it('7. entity-face conditional GET round-trip: repeat browser GET with If-None-Match: <-nav etag> -> 304', async () => {
    const first = await request('/alice/public/wiki/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assert.equal(first.status, 200);
    const navEtag = first.headers.get('etag');
    assert.ok(navEtag);
    const second = await request('/alice/public/wiki/x.md', {
      headers: { Accept: BROWSER_ACCEPT, 'If-None-Match': navEtag }, auth: 'alice',
    });
    assert.equal(second.status, 304, 'a repeat entity-face GET presenting its own -nav etag must 304');
  });

  it('a -nav etag must not validate a machine text/markdown conditional GET (no cross-contamination)', async () => {
    const nav = await request('/alice/public/wiki/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assert.equal(nav.status, 200);
    const navEtag = nav.headers.get('etag');
    const machine = await request('/alice/public/wiki/x.md', {
      headers: { Accept: 'text/markdown', 'If-None-Match': navEtag }, auth: 'alice',
    });
    assert.equal(machine.status, 200, 'a machine conditional GET presenting a -nav etag must not 304');
  });

  it('HEAD parity: content-type text/html, empty body, same -nav ETag as GET', async () => {
    const getRes = await request('/alice/public/wiki/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    const headRes = await request('/alice/public/wiki/x.md', {
      method: 'HEAD', headers: { Accept: BROWSER_ACCEPT }, auth: 'alice',
    });
    assert.equal(headRes.status, 200);
    assert.match(headRes.headers.get('content-type') || '', /text\/html/);
    assert.equal(headRes.headers.get('etag'), getRes.headers.get('etag'));
    assert.equal(await headRes.text(), '');
  });
});

describe('lws: navigator generic entity face — non-lws server keeps mashlib unchanged', () => {
  let base;

  before(async () => {
    await startTestServer({ mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('carol3');
    await request('/carol3/public/x.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'carol3', body: '# x\n',
    });
  });
  after(stopTestServer);

  it('5. --lws off: browser GET still gets the mashlib wrapper (byte-identical legacy)', async () => {
    const r = await request('/carol3/public/x.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'carol3' });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /runDataBrowser|mashlib\.min\.js/);
  });
});

// Review follow-up (2026-07-15): the arm above intercepted EVERY stored
// content type once browserWantsHtml was true, regressing the mashlib
// precedent (src/mashlib/index.js:380-382) that image/video/audio/pdf
// render natively rather than behind a metadata page. entityFaceViewable
// (src/navigator/views.js) restores that: default entity face only for
// data types (RDF/markdown/text); ?view=nav still forces it for any type.
describe('lws: navigator entity face — content-type gate (review fix)', () => {
  let base;
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
  const BIG_TEXT = 'x'.repeat(300 * 1024); // > DATA_ISLAND_MAX_BYTES (256KB)

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('dana');
    await request('/dana/public/wiki/photo.png', {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, auth: 'dana', body: PNG_BYTES,
    });
    await request('/dana/public/wiki/big.txt', {
      method: 'PUT', headers: { 'Content-Type': 'text/plain' }, auth: 'dana', body: BIG_TEXT,
    });
  });
  after(stopTestServer);

  it('1. browser GET of image/png -> 200 raw bytes (native render, not the entity face)', async () => {
    const r = await request('/dana/public/wiki/photo.png', { headers: { Accept: BROWSER_ACCEPT }, auth: 'dana' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /^image\/png/);
    const body = Buffer.from(await r.arrayBuffer());
    assert.ok(body.equals(PNG_BYTES), 'must serve the raw PNG bytes unchanged, not an HTML wrapper');
  });

  it('2. ?view=nav on the same image -> 200 entity view (explicit escape hatch works for any type)', async () => {
    const r = await request('/dana/public/wiki/photo.png?view=nav', {
      headers: { Accept: BROWSER_ACCEPT }, auth: 'dana',
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /image\/png/, 'entity view must show the stored media type fact');
  });

  it('3. large text file (>256KB) -> entity face 200 with no unbounded-read preview', async () => {
    const r = await request('/dana/public/wiki/big.txt', { headers: { Accept: BROWSER_ACCEPT }, auth: 'dana' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.doesNotMatch(body, /<pre/, 'a >256KB file must not carry an excerpt preview');
  });
});

describe('lws: navigator entity face — no mashlibCdn (review fix coverage)', () => {
  let base;

  before(async () => {
    // No mashlibCdn: true here — pins that the entity-face arm doesn't
    // depend on mashlibEnabled (it replaces mashlib entirely under --lws).
    await startTestServer({ lws: true, conneg: true });
    base = getBaseUrl();
    await createTestPod('erin');
    await request('/erin/public/wiki/note.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'erin', body: '# note\n',
    });
  });
  after(stopTestServer);

  it('4. markdown browser GET -> entity face 200 even with mashlibCdn off', async () => {
    const r = await request('/erin/public/wiki/note.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'erin' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
  });
});
