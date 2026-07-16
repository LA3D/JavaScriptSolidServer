// test/lws-navigator-multitenant.test.js
// Task A10 (multi-tenant round): the navigator's chrome goes per-storage —
// crumbHtml's leading segment links to the OWNING storage root (not a
// single hardcoded 'pod'/'/'), and the server root (`/?view=nav`) becomes a
// WAC-filtered roster of every storage the pod hosts (renderServerIndexView)
// instead of one storage's own view (renderRootView, now reached only at
// `/<pod>/?view=nav`). Navigator stays PROFILE-BLIND — this is chrome +
// data-source wiring on top of storageRootFor (A2)/listVisibleStorageRoots
// (A5)/buildStorageDescriptionFor (A4), not new app logic.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crumbHtml, renderServerIndexView } from '../src/navigator/views.js';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

describe('crumbHtml: per-storage leading crumb (unit)', () => {
  it('a storageRootPath links the first crumb to the owning storage, not /', () => {
    const html = crumbHtml('http://h/alice/wiki/a.md', '/alice/');
    assert.match(html, /href="\/alice\/\?view=nav"[^>]*>alice/);
    assert.ok(!/>pod</.test(html), 'no hardcoded single-pod crumb');
  });

  it('the deepest segment stays plain text (current page, not a link)', () => {
    const html = crumbHtml('http://h/alice/wiki/a.md', '/alice/');
    assert.ok(html.trimEnd().endsWith('a.md'), 'the leaf segment must be the trailing plain-text crumb');
    assert.ok(!/<a[^>]*>a\.md<\/a>/.test(html), 'the leaf segment must not itself be a link');
  });

  it('at the storage root itself, the crumb is just the owning-storage link (no trailing segment)', () => {
    const html = crumbHtml('http://h/alice/', '/alice/');
    assert.equal(html, '<a href="/alice/?view=nav">alice</a>');
  });

  it('server scope (no storageRootPath): first crumb reads "server", not "pod"', () => {
    const html = crumbHtml('http://h/robots.txt', null);
    assert.match(html, /href="\/\?view=nav"[^>]*>server/);
    assert.ok(!/>pod</.test(html));
  });
});

describe('renderServerIndexView: WAC-visible storage roster (unit)', () => {
  it('lists a link to each storage\'s own ?view=nav', () => {
    const html = renderServerIndexView({ origin: 'http://h', storages: [{ root: '/alice/' }, { root: '/bob/' }] });
    assert.match(html, /\/alice\/\?view=nav/);
    assert.match(html, /\/bob\/\?view=nav/);
    assert.match(html, />alice</);
    assert.match(html, />bob</);
  });

  it('an empty roster still renders a valid page (no storages, not an error)', () => {
    const html = renderServerIndexView({ origin: 'http://h', storages: [] });
    assert.match(html, /<html/);
  });
});

describe('lws: navigator server index + per-storage root view (HTTP, Task A10)', () => {
  let base;

  before(async () => {
    await startTestServer({ lws: true, mashlibCdn: true });
    base = getBaseUrl();
    await createTestPod('alice');
    await request('/alice/public/wiki/note.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      auth: 'alice',
      body: '# note\n',
    });
  });
  after(stopTestServer);

  it('GET /?view=nav: server index lists the alice storage, links to /alice/?view=nav', async () => {
    const r = await request('/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    assert.match(r.headers.get('content-type') || '', /text\/html/);
    const body = await r.text();
    assert.ok(body.includes(`${base}/alice/?view=nav`), 'must link the alice storage\'s own nav view');
    assert.doesNotMatch(body, /<h2>Storage<\/h2>/, 'server index is a roster, not a single storage\'s view');
  });

  it('GET /alice/?view=nav: alice\'s own storage view — a service, a capability-bearing heading, breadcrumb rooted at alice', async () => {
    const r = await request('/alice/?view=nav', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /<h2>Storage<\/h2>/, 'must render the per-storage Storage heading');
    assert.match(body, /StorageDescription/, 'must list this storage\'s own service');
    assert.match(body, /href="\/alice\/\?view=nav"[^>]*>alice/, 'breadcrumb roots at alice, not pod');
  });

  it('GET /alice/public/wiki/ (a deeper container): breadcrumb roots at alice, not pod, and is chained through the owning storage', async () => {
    const r = await request('/alice/public/wiki/', { headers: { Accept: BROWSER_ACCEPT } });
    assertStatus(r, 200);
    const body = await r.text();
    assert.match(body, /href="\/alice\/\?view=nav"[^>]*>alice/, 'breadcrumb must root at the owning storage');
    assert.ok(!/>pod</.test(body), 'no hardcoded single-pod crumb');
  });
});
