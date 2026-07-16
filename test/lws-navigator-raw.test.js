// test/lws-navigator-raw.test.js
// Fork bug fix (branch la3d/lws-force-raw): a browser landing on the
// navigator's entity/container views has no way to actually reach a
// resource's machine representation — every "raw"/"machine view" link the
// navigator emits points at the BARE resource URL, which a browser
// (Accept: text/html) just loops right back into the same HTML view. `?raw`
// (bare presence, no value needed) is the escape: for THIS GET/HEAD only,
// behave as if the request were NOT browser-html-shaped, so it falls
// through to the exact same machine-facing code a non-browser Accept would
// hit — bypassing the entity face, the navigator container view, the
// index.html shadow, and the text/html face-dispatch 303. Distinct from
// `?view=nav` (which asks for MORE metadata) — `?raw` asks for LESS: the
// actual bytes, not a page about them.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl,
} from './helpers.js';
import { renderEntityView, renderContainerView } from '../src/navigator/views.js';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const MD_BODY = '# raw escape\n';
const TTL_BODY = '@prefix schema: <https://schema.org/> .\n<#it> a schema:Thing .\n';

describe('lws: ?raw force-raw escape (navigator)', () => {
  let base;

  before(async () => {
    await startTestServer({ lws: true, conneg: true, mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('alice');
    await request('/alice/public/wiki/a.md', {
      method: 'PUT', headers: { 'Content-Type': 'text/markdown' }, auth: 'alice', body: MD_BODY,
    });
    await request('/alice/public/wiki/a.ttl', {
      method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, auth: 'alice', body: TTL_BODY,
    });
  });
  after(stopTestServer);

  it('browser GET without ?raw -> the HTML entity face', async () => {
    const r = await request('/alice/public/wiki/a.md', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /<nav class="crumb"/, 'must be the navigator entity-face chrome');
  });

  it('the SAME browser GET WITH ?raw -> the stored bytes, real Content-Type, not HTML', async () => {
    const r = await request('/alice/public/wiki/a.md?raw', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assert.equal(r.status, 200);
    const contentType = r.headers.get('content-type') || '';
    assert.match(contentType, /text\/markdown/, 'must serve the real stored Content-Type');
    assert.doesNotMatch(contentType, /text\/html/, 'must not be the entity-face HTML');
    const body = await r.text();
    assert.equal(body, MD_BODY, 'must be the verbatim stored bytes, not the entity-face wrapper');
    assert.doesNotMatch(body, /<nav class="crumb"/, 'must not carry the navigator chrome');
    assert.doesNotMatch(body, /machine views/, 'must not carry the entity-face metadata dl');
  });

  it('?raw on an RDF (turtle) resource -> the machine representation, not the entity face', async () => {
    const r = await request('/alice/public/wiki/a.ttl?raw', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assert.equal(r.status, 200);
    const contentType = r.headers.get('content-type') || '';
    assert.doesNotMatch(contentType, /text\/html/, 'must not be the entity-face HTML');
    const body = await r.text();
    assert.doesNotMatch(body, /<nav class="crumb"/, 'must not carry the navigator chrome');
    assert.doesNotMatch(body, /<!doctype html/i, 'must not be an HTML document at all');
  });

  it('container browser GET with ?raw -> the machine listing, not the navigator/index.html view', async () => {
    const r = await request('/alice/public/wiki/?raw', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assert.equal(r.status, 200);
    const contentType = r.headers.get('content-type') || '';
    assert.match(contentType, /application\/(ld\+json|lws\+json)/, 'must be a machine listing content type');
    assert.doesNotMatch(contentType, /text\/html/, 'must not be the navigator container view');
    const body = await r.text();
    assert.doesNotMatch(body, /<nav class="crumb"/, 'must not carry the navigator chrome');
    assert.doesNotMatch(body, /<!doctype html/i, 'must not be an HTML document at all');
  });

  it('HEAD parity: ?raw on the data resource reports the same non-HTML Content-Type as GET, empty body', async () => {
    const getRes = await request('/alice/public/wiki/a.md?raw', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    const headRes = await request('/alice/public/wiki/a.md?raw', {
      method: 'HEAD', headers: { Accept: BROWSER_ACCEPT }, auth: 'alice',
    });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-type'), getRes.headers.get('content-type'));
    assert.doesNotMatch(headRes.headers.get('content-type') || '', /text\/html/);
    assert.equal(await headRes.text(), '');
  });

  it('?view=nav is unaffected by this change — still the entity view (distinct escape)', async () => {
    const r = await request('/alice/public/wiki/a.md?view=nav', { headers: { Accept: BROWSER_ACCEPT }, auth: 'alice' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.match(body, /<nav class="crumb"/);
  });
});

// Regression (review of la3d/lws-force-raw): the mashlib gate this ?raw
// escape guards (~line 1384) has NO lwsEnabled guard of its own — it's only
// reachable when !request.lwsEnabled (the --lws-OFF legacy mashlib path;
// under --lws it's shadowed by the entity-face arm, which returns first).
// So a bare ?raw on an --lws-OFF pod was suppressing the mashlib wrapper
// too, changing --lws-OFF behavior (the brief requires it byte-identical)
// and putting GET/HEAD in disagreement (HEAD's getMashlibEtag/
// isMashlibResponse were never touched, so HEAD still reports the mashlib
// Content-Type/ETag while GET?raw reports the raw ones — RFC 9110 §9.3.2).
describe('lws-OFF: ?raw must be a no-op (mashlib GET/HEAD parity, no --lws)', () => {
  let base;

  before(async () => {
    await startTestServer({ mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('bob');
    await request('/bob/public/note.jsonld', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      auth: 'bob',
      body: JSON.stringify({ '@context': { schema: 'https://schema.org/' }, '@id': '#it', '@type': 'schema:Thing' }),
    });
  });
  after(stopTestServer);

  it('GET ?raw and GET (bare) return the IDENTICAL mashlib Content-Type + ETag', async () => {
    const bare = await request('/bob/public/note.jsonld', { headers: { Accept: BROWSER_ACCEPT }, auth: 'bob' });
    const raw = await request('/bob/public/note.jsonld?raw', { headers: { Accept: BROWSER_ACCEPT }, auth: 'bob' });
    assert.equal(bare.status, 200);
    assert.equal(raw.status, 200);
    assert.match(bare.headers.get('content-type') || '', /text\/html/, 'bare GET must be the mashlib wrapper');
    assert.equal(raw.headers.get('content-type'), bare.headers.get('content-type'), '?raw must not change Content-Type under --lws-off');
    assert.equal(raw.headers.get('etag'), bare.headers.get('etag'), '?raw must not change ETag under --lws-off');
    const rawBody = await raw.text();
    assert.match(rawBody, /<!doctype html>/i, '?raw must still be the mashlib HTML wrapper, not raw bytes');
  });

  it('GET ?raw and HEAD ?raw agree on Content-Type + ETag (RFC 9110 9.3.2)', async () => {
    const getRes = await request('/bob/public/note.jsonld?raw', { headers: { Accept: BROWSER_ACCEPT }, auth: 'bob' });
    const headRes = await request('/bob/public/note.jsonld?raw', {
      method: 'HEAD', headers: { Accept: BROWSER_ACCEPT }, auth: 'bob',
    });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-type'), getRes.headers.get('content-type'));
    assert.equal(headRes.headers.get('etag'), getRes.headers.get('etag'));
    assert.match(headRes.headers.get('content-type') || '', /text\/html/);
  });
});

describe('lws: ?raw force-raw escape — views unit (raw/machine-view link hrefs)', () => {
  it('renderEntityView: the "raw" link href carries ?raw', () => {
    const html = renderEntityView({ url: 'http://h/x', reps: { alternates: [] } });
    assert.match(html, /href="http:\/\/h\/x\?raw">raw</);
  });

  it('renderEntityView: a non-html alternate rep link also carries ?raw', () => {
    const html = renderEntityView({
      url: 'http://h/x',
      reps: { alternates: [{ href: 'http://h/x.jsonld', format: 'application/ld+json' }] },
    });
    assert.match(html, /href="http:\/\/h\/x\.jsonld\?raw"/, 'a data alternate must carry ?raw');
  });

  it('renderEntityView: an html alternate rep link stays bare (no ?raw needed)', () => {
    const html = renderEntityView({
      url: 'http://h/x',
      reps: { alternates: [{ href: 'http://h/x.html', format: 'text/html' }] },
    });
    assert.match(html, /href="http:\/\/h\/x\.html"/, 'an html face may stay bare');
  });

  it('renderContainerView: the "machine view" link href ends ?raw', () => {
    const html = renderContainerView({ url: 'http://h/c/', items: [] });
    assert.match(html, /href="http:\/\/h\/c\/\?raw">machine view</);
  });
});
