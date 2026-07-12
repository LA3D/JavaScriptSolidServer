import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  stopTestServer,
  request,
  createTestPod,
  assertStatus,
} from './helpers.js';

describe('LWS container conformance (e2e)', () => {
  before(async () => {
    await startTestServer({ lws: true });
    await createTestPod('alice');

    // Create sub-container and one data member under the public path
    await request('/alice/public/notes/', {
      method: 'PUT',
      auth: 'alice'
    });
    // PUT Turtle to a .ttl URL (extension → mediaType in LWS listing). Under
    // --lws the write-consistency gate (B1) rejects a JSON-LD body at a .ttl
    // name as a name/type lie, so the body's type must match the extension.
    await request('/alice/public/notes/note.ttl', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: '@prefix dc: <http://purl.org/dc/terms/> .\n<#n> dc:title "Test note" .',
      auth: 'alice'
    });
  });

  after(async () => {
    await stopTestServer();
  });

  it('GET with Accept: application/lws+json — LWS contract (headers)', async () => {
    const res = await request('/alice/public/notes/', {
      headers: { Accept: 'application/lws+json' }
    });
    assertStatus(res, 200);

    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    assert.equal(ct, 'application/lws+json', 'Content-Type must be application/lws+json');

    const link = res.headers.get('link') || '';
    assert.match(link, /rel="up"/, 'Link header must contain rel="up"');

    const etag = res.headers.get('etag');
    assert.ok(etag, 'ETag header must be present');
  });

  it('GET with Accept: application/lws+json — LWS contract (body shape)', async () => {
    const res = await request('/alice/public/notes/', {
      headers: { Accept: 'application/lws+json' }
    });
    assertStatus(res, 200);

    const body = await res.json();
    assert.equal(body['@context'], 'https://www.w3.org/ns/lws/v1', '@context must be lws/v1');
    assert.equal(body.type, 'Container', 'type must be Container');
    assert.equal(typeof body.totalItems, 'number', 'totalItems must be a number');
    assert.ok(Array.isArray(body.items), 'items must be an array');
    assert.ok(
      body.items.some(i => i.id.endsWith('note.ttl') && i.type === 'DataResource' && i.mediaType),
      'items must include note.ttl as a DataResource with a mediaType'
    );
  });

  it('GET with Accept: application/ld+json — LDP negative control', async () => {
    const res = await request('/alice/public/notes/', {
      headers: { Accept: 'application/ld+json' }
    });
    assertStatus(res, 200);

    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    assert.equal(ct, 'application/ld+json', 'negative control must return LDP (application/ld+json)');

    const body = await res.json();
    assert.ok(body.contains !== undefined, 'LDP response must have ldp:contains (mapped as "contains")');
  });

  it('GET with no Accept — LDP negative control (additivity)', async () => {
    const res = await request('/alice/public/notes/');
    assertStatus(res, 200);

    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    assert.equal(ct, 'application/ld+json', 'default GET without lws+json Accept must remain LDP');
  });

  it('Vary header includes Accept for lws+json response when --lws on (cache correctness)', async () => {
    const res = await request('/alice/public/notes/', {
      headers: { Accept: 'application/lws+json' }
    });
    assertStatus(res, 200);
    const vary = res.headers.get('vary') || '';
    assert.ok(vary.toLowerCase().includes('accept'), `Vary must include Accept for lws+json response, got: ${vary}`);
  });

  it('Vary header includes Accept for ld+json response when --lws on (cache correctness)', async () => {
    const res = await request('/alice/public/notes/', {
      headers: { Accept: 'application/ld+json' }
    });
    assertStatus(res, 200);
    const vary = res.headers.get('vary') || '';
    assert.ok(vary.toLowerCase().includes('accept'), `Vary must include Accept for ld+json response when lws enabled, got: ${vary}`);
  });
});
