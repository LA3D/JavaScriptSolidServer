// test/lws-options-links.test.js
// F7: OPTIONS answers "what can I do here" but was built via getAllHeaders
// WITHOUT `lwsEnabled` — so it silently dropped the storageDescription (+
// linkset) Link rels that GET/HEAD both carry under --lws. A client that
// preflights with OPTIONS (the RFC 9110-idiomatic discovery probe) never
// saw the storage-description pointer GET would have given it.
//
// Fix: handleOptions passes `lwsEnabled: request.lwsEnabled` into
// getAllHeaders — representations/chosenProfile stay out, since OPTIONS
// does no content negotiation.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, assertStatus,
} from './helpers.js';

const STORAGE_DESC_REL = 'https://www.w3.org/ns/lws#storageDescription';

describe('lws: OPTIONS carries storage-description Link (F7)', () => {
  before(async () => {
    await startTestServer({ lws: true });
    await createTestPod('optlink');
    await request('/optlink/note.ttl', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      auth: 'optlink',
      body: '<#it> a <http://example.org/Thing> .',
    });
  });
  after(stopTestServer);

  it('OPTIONS on a container advertises rel="…storageDescription"', async () => {
    const r = await request('/optlink/', { method: 'OPTIONS', auth: 'optlink' });
    assertStatus(r, 204);
    assert.match(r.headers.get('link') || '', new RegExp(`rel="${STORAGE_DESC_REL}"`));
  });

  it('OPTIONS on a resource advertises rel="…storageDescription"', async () => {
    const r = await request('/optlink/note.ttl', { method: 'OPTIONS', auth: 'optlink' });
    assertStatus(r, 204);
    assert.match(r.headers.get('link') || '', new RegExp(`rel="${STORAGE_DESC_REL}"`));
  });

  it('OPTIONS still lists Allow methods (unaffected by the Link fix)', async () => {
    const r = await request('/optlink/', { method: 'OPTIONS', auth: 'optlink' });
    assertStatus(r, 204);
    const allow = r.headers.get('allow') || '';
    assert.ok(allow.includes('GET'), 'Allow must still include GET');
  });
});

describe('lws: OPTIONS Link unchanged when --lws is off (negative)', () => {
  before(async () => {
    await startTestServer({});
    await createTestPod('optoff');
    await request('/optoff/note.ttl', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      auth: 'optoff',
      body: '<#it> a <http://example.org/Thing> .',
    });
  });
  after(stopTestServer);

  it('OPTIONS on a container carries NO storageDescription rel', async () => {
    const r = await request('/optoff/', { method: 'OPTIONS', auth: 'optoff' });
    assertStatus(r, 204);
    assert.equal((r.headers.get('link') || '').includes('storageDescription'), false);
  });

  it('OPTIONS on a resource carries NO storageDescription rel', async () => {
    const r = await request('/optoff/note.ttl', { method: 'OPTIONS', auth: 'optoff' });
    assertStatus(r, 204);
    assert.equal((r.headers.get('link') || '').includes('storageDescription'), false);
  });
});
