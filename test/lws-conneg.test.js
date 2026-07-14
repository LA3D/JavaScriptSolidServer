import { test, describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { selectContentType, RDF_TYPES } from '../src/rdf/conneg.js';
import { startTestServer, stopTestServer, request, createTestPod, getBaseUrl } from './helpers.js';

test('lws+json is a known RDF type', () => {
  assert.equal(RDF_TYPES.LWS_JSON, 'application/lws+json');
});

test('explicit Accept: application/lws+json is selected', () => {
  assert.equal(selectContentType('application/lws+json', false), 'application/lws+json');
});

test('absent lws+json, behavior is unchanged (defaults to JSON-LD)', () => {
  assert.equal(selectContentType('text/turtle', false), RDF_TYPES.JSON_LD); // conneg off
  assert.equal(selectContentType('application/ld+json', false), RDF_TYPES.JSON_LD);
});

test('linkset+json is a known RDF type and is negotiable', () => {
  assert.equal(RDF_TYPES.LINKSET, 'application/linkset+json');
  assert.equal(selectContentType('application/linkset+json', false), 'application/linkset+json');
});

test('linkset+json fires before connegEnabled guard — true flag also returns linkset+json', () => {
  assert.equal(selectContentType('application/linkset+json', true), 'application/linkset+json');
});

// Task 9: the 404 path (getNotFoundHeaders) must advertise Accept-Patch
// identically to the 200 path (getResponseHeaders/getAllHeaders) under --lws.
describe('404 Accept-Patch parity under --lws', () => {
  let base;
  before(async () => {
    await startTestServer({ lws: true });
    base = getBaseUrl();
    await createTestPod('alice');
  });
  after(stopTestServer);

  it('a 404 under --lws advertises merge-patch in Accept-Patch', async () => {
    // .ttl name not covered by any uriSpace — reaches the plain 404 branch,
    // not the uriSpace 303 referent resolver.
    const res = await request(`${base}/alice/nonexistent.ttl`, { method: 'GET', auth: 'alice' });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('accept-patch') || '', /merge-patch\+json/, '404 Accept-Patch names merge-patch');
  });
});
