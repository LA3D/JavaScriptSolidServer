// test/lws-envelope-admission.test.js
// Pins the composition the serving-path round left unpinned (spec 2026-07-11
// §6): a SHACL shapes doc published as TURTLE — multi-subject, so the conneg
// write path stores it as the self-describing {@context,@graph} envelope
// (spec 2026-07-10 §3), not a legacy single-node doc — still rejects a
// non-conforming write end-to-end through the container .meta powder-s:
// describedby admission gate. This currently holds by composition (the
// real-JSON-LD-parser toDataset arm + the graph-envelope store form) but was
// never pinned; this test is the regression tripwire.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';

// Multi-subject (two NodeShapes) so the conneg write path stores this as the
// {@context,@graph} envelope rather than a single-node doc.
const SHAPE_TTL = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://ex.org/> .

ex:NoteShape a sh:NodeShape ;
  sh:targetClass ex:Note ;
  sh:property [
    sh:path ex:title ;
    sh:minCount 1 ;
    sh:severity sh:Violation ;
    sh:message "title required"
  ] .

ex:OtherShape a sh:NodeShape ;
  sh:targetClass ex:Other ;
  sh:property [
    sh:path ex:name ;
    sh:minCount 1 ;
    sh:severity sh:Violation ;
    sh:message "name required"
  ] .
`;

// `.jsonld` extension: getContentType() derives the served Content-Type from
// the file extension, not the PUT request's header — the conneg write path
// converts the turtle body to JSON-LD bytes, so the extension must match
// what's actually stored or GET-with-conneg (Step 3 below) 406s serving an
// extensionless resource labeled application/octet-stream.
const SHAPE_PATH = '/alice/public/shapes/Note.jsonld';
const CONTAINER = '/alice/public/notes/';

describe('envelope-shape admission pin', () => {
  let base;
  let shapeUrl;

  before(async () => {
    await startTestServer({ lws: true, conneg: true });
    await createTestPod('alice');
    base = getBaseUrl();
    shapeUrl = `${base}${SHAPE_PATH}`;

    // Create the notes container.
    await request(CONTAINER, { method: 'PUT', auth: 'alice' });

    // PUT the SHACL shapes doc as TURTLE — multi-subject, so the conneg write
    // path stores it as {@context,@graph}, not a legacy single-node doc.
    await request(SHAPE_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: SHAPE_TTL,
      auth: 'alice',
    });

    // Bind the container to the shape via powder-s:describedby.
    await request(`${CONTAINER}.meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@id': `${base}${CONTAINER}`,
        [DESCRIBEDBY]: { '@id': shapeUrl },
      }),
      auth: 'alice',
    });
  });

  after(async () => { await stopTestServer(); });

  it('non-conforming write → 400 with the sh:message teaching text', async () => {
    const res = await request(`${CONTAINER}n1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      // ex:Note with NO ex:title → violates sh:minCount 1 on NoteShape
      body: JSON.stringify({
        '@context': { ex: 'http://ex.org/' },
        '@id': `${base}${CONTAINER}n1`,
        '@type': 'ex:Note',
      }),
      auth: 'alice',
    });
    assertStatus(res, 400, `Expected 400, got ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    assert.match(ct, /application\/problem\+json/);
    const link = res.headers.get('link') || '';
    assert.match(link, /rel="describedby"/, `Link header missing rel="describedby": ${link}`);
    const body = await res.json();
    assert.equal(body.status, 400);
    assert.ok(
      Array.isArray(body.violations) && body.violations.some((v) => v.message === 'title required'),
      `Expected violation "title required" in ${JSON.stringify(body.violations)}`,
    );
  });

  it('conforming write → 2xx', async () => {
    const res = await request(`${CONTAINER}n2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      // ex:Note WITH ex:title → conforms
      body: JSON.stringify({
        '@context': { ex: 'http://ex.org/' },
        '@id': `${base}${CONTAINER}n2`,
        '@type': 'ex:Note',
        'ex:title': 'hi',
      }),
      auth: 'alice',
    });
    assert.ok(res.status === 201 || res.status === 204, `Expected 201/204, got ${res.status}`);
    const link = res.headers.get('link') || '';
    assert.match(link, /rel="describedby"/, `Link header missing rel="describedby": ${link}`);
  });

  it('the stored shape doc round-trips as {@context,@graph} (envelope form asserted)', async () => {
    const res = await request(SHAPE_PATH, { headers: { Accept: 'application/ld+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.ok(!Array.isArray(body), 'never the legacy top-level array');
    assert.ok(Array.isArray(body['@graph']), 'expected the self-describing envelope store form');
    assert.ok(body['@graph'].length >= 2, `expected multi-subject @graph, got ${body['@graph'].length}`);
  });
});
