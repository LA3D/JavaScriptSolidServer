/**
 * LWS storage-description + per-resource linkset end-to-end conformance test.
 *
 * Covers:
 *   1. GET /.well-known/lws-storage body shape (Task 1)
 *   2. storageDescription + linkset Link rels on GET and HEAD (Tasks 3/6)
 *   3. Per-resource linkset via conneg (Tasks 4/5)
 *   4. HEAD content-type parity for linkset+json (Task 6)
 *   5. Negative controls: lws OFF → no rels/route; lws ON + default Accept → LDP
 *   6. NotificationService entry in storage description (Task 2 gap)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer,
  stopTestServer,
  request,
  createTestPod,
  assertStatus,
} from './helpers.js';

const SD_PATH = '/.well-known/lws-storage';
const SD_REL = 'https://www.w3.org/ns/lws#storageDescription';
const LWS_CONTEXT = 'https://www.w3.org/ns/lws/v1';
const NOTE_PATH = '/alice/notes/note.ttl';

// ---------------------------------------------------------------------------
// Main conformance suite: --lws ON
// public:true bypasses WAC so unauthenticated reads work without the pod's
// /public/ ACL path — keeps NOTE_PATH at /alice/notes/note.ttl as in brief.
// ---------------------------------------------------------------------------
describe('LWS discovery conformance (--lws ON)', () => {
  before(async () => {
    await startTestServer({ lws: true, public: true });
    await createTestPod('alice');

    // Create container
    await request('/alice/notes/', { method: 'PUT', auth: 'alice' });

    // Create a data resource (JSON-LD — .ttl extension storage, same as lws-conformance.test.js)
    await request(NOTE_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({ '@context': { dc: 'http://purl.org/dc/terms/' }, '@id': '#n', 'dc:title': 'Conformance note' }),
      auth: 'alice',
    });
  });

  after(async () => {
    await stopTestServer();
  });

  // (a) Storage Description resource
  it('GET /.well-known/lws-storage → 200, application/lws+json', async () => {
    const res = await request(SD_PATH, { headers: { Accept: 'application/lws+json' } });
    assertStatus(res, 200);
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    assert.equal(ct, 'application/lws+json');
  });

  it('Storage Description body: @context / type / StorageDescription service', async () => {
    const res = await request(SD_PATH, { headers: { Accept: 'application/lws+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.equal(body['@context'], LWS_CONTEXT, '@context must be lws/v1');
    assert.equal(body.type, 'Storage', 'type must be Storage');
    assert.ok(Array.isArray(body.service), 'service must be an array');
    const sd = body.service.find(s => s.type === 'StorageDescription');
    assert.ok(sd, 'service must contain a StorageDescription entry');
    assert.ok(sd.serviceEndpoint, 'StorageDescription must have serviceEndpoint');
    assert.ok(
      sd.serviceEndpoint.endsWith('/.well-known/lws-storage'),
      `serviceEndpoint should end with /.well-known/lws-storage, got: ${sd.serviceEndpoint}`
    );
  });

  // (b) storageDescription + linkset Link rels on a regular resource GET
  it('GET resource → Link: rel="storageDescription" present', async () => {
    const res = await request(NOTE_PATH, { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 200);
    const link = res.headers.get('link') || '';
    assert.match(link, new RegExp(`rel="${SD_REL.replace(/\//g, '\\/')}"`),
      `Link header must contain rel="${SD_REL}", got: ${link}`);
  });

  it('GET resource → Link: rel="linkset" present', async () => {
    const res = await request(NOTE_PATH, { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 200);
    const link = res.headers.get('link') || '';
    assert.match(link, /rel="linkset"/, `Link header must contain rel="linkset", got: ${link}`);
  });

  // (c) per-resource linkset via conneg
  it('GET resource with Accept: application/linkset+json → linkset+json content-type', async () => {
    const res = await request(NOTE_PATH, { headers: { Accept: 'application/linkset+json' } });
    assertStatus(res, 200);
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    assert.equal(ct, 'application/linkset+json');
  });

  it('linkset body: anchor ends with note path', async () => {
    const res = await request(NOTE_PATH, { headers: { Accept: 'application/linkset+json' } });
    const body = await res.json();
    assert.ok(Array.isArray(body.linkset), 'linkset must be an array');
    const link = body.linkset[0];
    assert.ok(link.anchor.endsWith(NOTE_PATH),
      `anchor should end with ${NOTE_PATH}, got: ${link.anchor}`);
  });

  it('linkset body: type[0].href is LWS DataResource', async () => {
    const res = await request(NOTE_PATH, { headers: { Accept: 'application/linkset+json' } });
    const body = await res.json();
    const link = body.linkset[0];
    assert.equal(link.type[0].href, 'https://www.w3.org/ns/lws#DataResource');
  });

  it('linkset body: up is present', async () => {
    const res = await request(NOTE_PATH, { headers: { Accept: 'application/linkset+json' } });
    const body = await res.json();
    const link = body.linkset[0];
    assert.ok(link.up, 'up must be present in linkset');
  });

  // (d) HEAD parity: discovery rels
  it('HEAD resource → Link: rel="storageDescription" present (HEAD parity)', async () => {
    const res = await request(NOTE_PATH, { method: 'HEAD' });
    assertStatus(res, 200);
    const link = res.headers.get('link') || '';
    assert.match(link, new RegExp(`rel="${SD_REL.replace(/\//g, '\\/')}"`),
      `HEAD Link header must contain rel="${SD_REL}", got: ${link}`);
  });

  it('HEAD resource → Link: rel="linkset" present (HEAD parity)', async () => {
    const res = await request(NOTE_PATH, { method: 'HEAD' });
    assertStatus(res, 200);
    const link = res.headers.get('link') || '';
    assert.match(link, /rel="linkset"/, `HEAD Link header must contain rel="linkset", got: ${link}`);
  });

  it('HEAD with Accept: application/linkset+json → content-type parity', async () => {
    const res = await request(NOTE_PATH, {
      method: 'HEAD',
      headers: { Accept: 'application/linkset+json' },
    });
    assertStatus(res, 200);
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    assert.equal(ct, 'application/linkset+json', 'HEAD content-type must match GET for linkset+json');
    // HEAD must not return a body (Content-Length should be absent or 0)
    const cl = res.headers.get('content-length');
    assert.ok(!cl || cl === '0', `HEAD must have no body; Content-Length=${cl}`);
  });

  // (e/b) Negative control: with --lws ON but default Accept, body is LDP
  it('GET container with no Accept → body is LDP (not linkset), additivity intact', async () => {
    const res = await request('/alice/notes/');
    assertStatus(res, 200);
    const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
    assert.equal(ct, 'application/ld+json',
      'default GET without Accept: lws+json must remain LDP (application/ld+json)');
  });
});

// ---------------------------------------------------------------------------
// Negative controls: --lws OFF
// ---------------------------------------------------------------------------
describe('LWS discovery negative controls (--lws OFF)', () => {
  before(async () => {
    await startTestServer({ public: true });
    await createTestPod('bob');
    await request('/bob/notes/', { method: 'PUT', auth: 'bob' });
    await request('/bob/notes/note.ttl', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({ '@context': { dc: 'http://purl.org/dc/terms/' }, '@id': '#n', 'dc:title': 'Bob note' }),
      auth: 'bob',
    });
  });

  after(async () => {
    await stopTestServer();
  });

  it('GET /.well-known/lws-storage → 404 when lws is off', async () => {
    const res = await request(SD_PATH, { headers: { Accept: 'application/lws+json' } });
    assertStatus(res, 404);
  });

  it('GET resource → Link header does NOT contain storageDescription rel when lws is off', async () => {
    const res = await request('/bob/notes/note.ttl', { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 200);
    const link = res.headers.get('link') || '';
    assert.ok(
      !link.includes('storageDescription'),
      `Link header must NOT contain storageDescription when lws is off, got: ${link}`
    );
  });

  it('GET resource → Link header does NOT contain linkset rel when lws is off', async () => {
    const res = await request('/bob/notes/note.ttl', { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 200);
    const link = res.headers.get('link') || '';
    assert.ok(
      !link.includes('rel="linkset"'),
      `Link header must NOT contain rel="linkset" when lws is off, got: ${link}`
    );
  });
});

// ---------------------------------------------------------------------------
// NotificationService in storage description (Task 2 gap)
// ---------------------------------------------------------------------------
describe('LWS NotificationService in storage description (--lws + --notifications)', () => {
  before(async () => {
    await startTestServer({ lws: true, notifications: true });
  });

  after(async () => {
    await stopTestServer();
  });

  it('service array contains a NotificationService entry', async () => {
    const res = await request(SD_PATH, { headers: { Accept: 'application/lws+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.service), 'service must be an array');
    const ns = body.service.find(s => s.type === 'NotificationService');
    assert.ok(ns, 'service must contain a NotificationService entry');
    assert.ok(ns.serviceEndpoint, 'NotificationService must have serviceEndpoint');
    assert.ok(
      ns.serviceEndpoint.endsWith('/notification/api'),
      `NotificationService serviceEndpoint should end with /notification/api, got: ${ns.serviceEndpoint}`
    );
  });
});
