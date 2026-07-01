import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLinkset } from '../src/lws/linkset.js';

const R = 'http://localhost:3000/alice/note.ttl';
const P = 'http://localhost:3000/alice/';
const SHAPE = 'http://localhost:3000/alice/shapes/Note';
const LWS = 'https://www.w3.org/ns/lws#';

test('linkset: RFC 9264 shape with anchor/up/type; describedby carries the shape', () => {
  const ls = generateLinkset(R, { parentUrl: P, isContainer: false, describedByShapes: [SHAPE] });
  const link = ls.linkset[0];
  assert.equal(link.anchor, R);
  assert.deepEqual(link.up, [{ href: P }]);
  assert.deepEqual(link.type, [{ href: LWS + 'DataResource' }]);
  assert.deepEqual(link.describedby, [{ href: SHAPE }]);
});

test('linkset: omits describedby when the resource declares no shape', () => {
  const ls = generateLinkset(R, { parentUrl: P, isContainer: false });
  assert.equal('describedby' in ls.linkset[0], false);
});

test('linkset: multiple shapes surface as multiple describedby hrefs', () => {
  const ls = generateLinkset(R, { isContainer: false, describedByShapes: [SHAPE, SHAPE + '2'] });
  assert.deepEqual(ls.linkset[0].describedby, [{ href: SHAPE }, { href: SHAPE + '2' }]);
});

test('linkset: container type + no up at storage root', () => {
  const ls = generateLinkset(P, { parentUrl: null, isContainer: true });
  assert.deepEqual(ls.linkset[0].type, [{ href: LWS + 'Container' }]);
  assert.equal('up' in ls.linkset[0], false);
});

test('includes declared types alongside the intrinsic class', () => {
  const ls = generateLinkset('https://pod/alice/p1', {
    isContainer: false, declaredTypes: ['https://schema.org/Person'],
  });
  const types = ls.linkset[0].type.map((t) => t.href);
  assert.deepEqual(types, ['https://www.w3.org/ns/lws#DataResource', 'https://schema.org/Person']);
});
