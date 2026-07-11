// test/lws-admission.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admit } from '../src/lws/admission.js';

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';
const SHAPE = `
@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <http://ex/> .
ex:S a sh:NodeShape ; sh:targetClass ex:Note ;
  sh:property [ sh:path ex:title ; sh:minCount 1 ; sh:severity sh:Violation ; sh:message "title required" ] ;
  sh:property [ sh:path ex:desc ; sh:minCount 1 ; sh:severity sh:Info ; sh:message "add a description" ] .`;
const metaJson = (s, shape) => Buffer.from(JSON.stringify({ '@id': s, [DESCRIBEDBY]: { '@id': shape } }));
const storage = () => ({
  files: {
    '/alice/x.meta': metaJson('http://h/alice/x', 'http://h/shapes/X'),
    '/shapes/X': Buffer.from(SHAPE),                       // shape stored as turtle for the test
  },
  async exists(p) { return p in this.files; },
  async read(p) { if (!(p in this.files)) throw new Error('ENOENT'); return this.files[p]; },
});
const opts = (content) => ({
  storage: storage(), content, contentType: 'text/turtle', resourceUrl: 'http://h/alice/x',
  targetMetaPath: '/alice/x.meta', containerMetaPath: '/alice/.meta',
  shapeUrlToPath: (u) => '/' + u.split('/h/')[1],          // http://h/shapes/X → /shapes/X
});
const TTL = (body) => Buffer.from(`@prefix ex: <http://ex/> . <http://h/alice/x> a ex:Note ${body} .`);

test('admit: conforming → admit, no violations/advisories', async () => {
  const r = await admit(opts(TTL('; ex:title "t" ; ex:desc "d"')));
  assert.equal(r.decision, 'admit');
  assert.equal(r.violations.length, 0);
  assert.equal(r.advisories.length, 0);
});

test('admit: missing required → reject with violation', async () => {
  const r = await admit(opts(TTL('; ex:desc "d"')));
  assert.equal(r.decision, 'reject');
  assert.equal(r.violations[0].message, 'title required');
  assert.equal(r.shapeUrl, 'http://h/shapes/X');
});

test('admit: missing optional → admit but advisory carries Info', async () => {
  const r = await admit(opts(TTL('; ex:title "t"')));
  assert.equal(r.decision, 'admit');
  assert.equal(r.advisories[0].severity, 'Info');
});

test('admit: no .meta → pass (opt-in miss), no validation', async () => {
  const o = opts(TTL('; ex:title "t"')); o.storage.files = {};
  const r = await admit(o);
  assert.equal(r.decision, 'pass');
  assert.equal(r.shapeUrl, null);
});

test('admit: non-RDF body → pass without validation', async () => {
  const o = opts(Buffer.from('\x89PNG')); o.contentType = 'image/png';
  const r = await admit(o);
  assert.equal(r.decision, 'pass');
  assert.equal(r.shapeUrl, null);
  assert.equal(r.violations.length, 0);
  assert.equal(r.advisories.length, 0);
});

test('admit: declared shape resource missing → pass (opt-in miss), no throw', async () => {
  // .meta declares a shape URL whose backing resource does not exist.
  // storage.read throws ENOENT for the missing shape path — must resolve to pass, not 500.
  const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';
  const missingMeta = Buffer.from(JSON.stringify({
    '@id': 'http://h/alice/x',
    [DESCRIBEDBY]: { '@id': 'http://h/shapes/MISSING' },
  }));
  const st = {
    files: { '/alice/x.meta': missingMeta },
    async exists(p) { return p in this.files; },
    async read(p) { if (!(p in this.files)) throw new Error('ENOENT'); return this.files[p]; },
  };
  const o = {
    storage: st,
    content: TTL('; ex:title "t"'),
    contentType: 'text/turtle',
    resourceUrl: 'http://h/alice/x',
    targetMetaPath: '/alice/x.meta',
    containerMetaPath: '/alice/.meta',
    shapeUrlToPath: (u) => '/' + u.split('/h/')[1],
  };
  const r = await admit(o);
  assert.equal(r.decision, 'pass');
  assert.equal(r.shapeUrl, null);
  assert.equal(r.violations.length, 0);
});

test('admit: shape stored as legacy ARRAY-form JSON-LD parses without 500 but degrades to vacuous admit (shim removed, spec 2026-07-10 §3)', async () => {
  // A text/turtle shape PUT through the conneg-enabled write path is stored as
  // JSON-LD; multi-subject docs (any realistic SHACL file) serialize as a
  // TOP-LEVEL ARRAY with @context on element 0 only. Still pinned here: the
  // media-type sniff recognizes '[' as JSON-LD — the bytes must not reach the
  // n3 Turtle parser ("Expected entity but got { on line 2" — the ld+json-500
  // bug, FOLLOWUP 2026-07-04). But the store-array shim that hoisted element
  // 0's context onto elements 1..n is retired (spec 2026-07-10 §3, decision
  // log #3: no migration): under standard JSON-LD the sh:property restriction
  // elements orphan, validation is vacuous, and the write is ADMITTED, not
  // rejected. The serializer round moves the store form to {@context,@graph}.
  const { toJsonLd } = await import('../src/rdf/conneg.js');
  const stored = Buffer.from(JSON.stringify(
    await toJsonLd(Buffer.from(SHAPE), 'text/turtle', 'http://h/shapes/X', true), null, 2));
  assert.equal(stored.toString('utf8').trimStart()[0], '[',
    'precondition: the legacy multi-subject store form is a top-level array');
  const o = opts(TTL('; ex:desc "d"'));
  o.storage.files['/shapes/X'] = stored;
  const r = await admit(o);                                  // no n3 throw — JSON-LD arm
  assert.equal(r.decision, 'admit');                         // was reject under the shim
  assert.equal(r.violations.length, 0);                      // restrictions orphaned — vacuous
});
