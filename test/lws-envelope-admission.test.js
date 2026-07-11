// test/lws-envelope-admission.test.js
// Pins the composition the serving-path round left unpinned (spec 2026-07-11
// §6), updated for the B1 root fix (spec §2, 2026-07-11): a SHACL shapes doc
// published as TURTLE is now stored AS TURTLE (no envelope conversion — the
// write path stores exactly what was submitted) and still rejects a
// non-conforming write end-to-end through the container .meta powder-s:
// describedby admission gate. This holds by composition (the real-parser
// toDataset arm on the Turtle-at-rest shape doc); this test is the
// regression tripwire.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, assertStatus,
} from './helpers.js';

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';

// Multi-subject (two NodeShapes) — exercises the same admission path
// regardless of subject count now that Turtle is stored raw (B1).
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

// `.ttl` extension: under --lws the write-time name/type consistency gate
// (src/lws/write-consistency.js) requires the submitted text/turtle body to
// live at a name whose extension agrees — B1 stores it raw, so `.ttl` is now
// the correct (and only accepted) extension for this Turtle-submitted shape.
const SHAPE_PATH = '/alice/public/shapes/Note.ttl';
// A second shape fixture, semantically identical, submitted directly as
// JSON-LD in the {@context,@graph} envelope shape — the envelope is a valid
// shape the CLIENT chose to submit, stored verbatim (no write-path wrapping
// ever applied to JSON-LD bodies, before or after B1).
const SHAPE_JSONLD_PATH = '/alice/public/shapes/NoteEnvelope.jsonld';
const SHAPE_JSONLD = {
  '@context': { sh: 'http://www.w3.org/ns/shacl#', ex: 'http://ex.org/' },
  '@graph': [
    {
      '@id': 'ex:NoteShape', '@type': 'sh:NodeShape',
      'sh:targetClass': { '@id': 'ex:Note' },
      'sh:property': { 'sh:path': { '@id': 'ex:title' }, 'sh:minCount': 1, 'sh:severity': { '@id': 'sh:Violation' }, 'sh:message': 'title required' },
    },
    {
      '@id': 'ex:OtherShape', '@type': 'sh:NodeShape',
      'sh:targetClass': { '@id': 'ex:Other' },
      'sh:property': { 'sh:path': { '@id': 'ex:name' }, 'sh:minCount': 1, 'sh:severity': { '@id': 'sh:Violation' }, 'sh:message': 'name required' },
    },
  ],
};
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

    // PUT the SHACL shapes doc as TURTLE — B1: stored raw, not converted.
    await request(SHAPE_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: SHAPE_TTL,
      auth: 'alice',
    });

    // A second, JSON-LD-submitted shape fixture (envelope form) — stored
    // verbatim, exercised only by the round-trip test below.
    await request(SHAPE_JSONLD_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify(SHAPE_JSONLD),
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

  it('the Turtle-submitted shape is stored AS Turtle, not the {@context,@graph} envelope (B1)', async () => {
    const res = await request(SHAPE_PATH, { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-type').split(';')[0], 'text/turtle');
    const body = await res.text();
    assert.ok(!body.trimStart().startsWith('{') && !body.trimStart().startsWith('['), 'stored as Turtle, not JSON');
    assert.match(body, /ex:title/);
  });

  it('a JSON-LD-submitted shape round-trips as {@context,@graph} (envelope only for JSON-LD writes)', async () => {
    const res = await request(SHAPE_JSONLD_PATH, { headers: { Accept: 'application/ld+json' } });
    assertStatus(res, 200);
    const body = await res.json();
    assert.ok(!Array.isArray(body), 'never the legacy top-level array');
    assert.ok(Array.isArray(body['@graph']), 'the client-submitted envelope form, stored verbatim');
    assert.ok(body['@graph'].length >= 2, `expected multi-subject @graph, got ${body['@graph'].length}`);
  });

  // N3-exclusion serving guard (spec 2026-07-10 §2, serve.js isOwnFormat):
  // N3 is deliberately excluded from the "own bytes" short-circuit because
  // QUADS_OUTPUTS maps N3→Turtle — serving N3 bytes as-is under a text/turtle
  // label would mislabel N3-specific syntax as generic Turtle. A stored .n3
  // resource requested as text/turtle must go through the real parser + n3
  // writer, not a byte passthrough.
  it('a stored .n3 resource served as text/turtle is a real conversion, not a mislabel', async () => {
    const N3_BODY = '@prefix ex: <http://ex.org/> .\nex:s ex:p "o" .';
    await request('/alice/public/note.n3', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/n3' },
      body: N3_BODY,
      auth: 'alice',
    });
    const res = await request('/alice/public/note.n3', { headers: { Accept: 'text/turtle' } });
    assertStatus(res, 200);
    assert.equal(res.headers.get('content-type').split(';')[0], 'text/turtle');
    const body = await res.text();
    // Real parse + re-serialize (not a byte passthrough): the n3 writer emits
    // full IRIs via its own COMMON_PREFIXES, not the source's `ex:` prefix.
    assert.match(body, /<http:\/\/ex\.org\/s> <http:\/\/ex\.org\/p> "o"/);
  });
});
