import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLinkset } from '../src/lws/linkset.js';

const R = 'http://localhost:3000/alice/note.ttl';
const P = 'http://localhost:3000/alice/';
const DESC = 'http://localhost:3000/.well-known/lws-storage';
const LWS = 'https://www.w3.org/ns/lws#';

test('linkset: RFC 9264 shape with anchor/up/type/describedby', () => {
  const ls = generateLinkset(R, { parentUrl: P, isContainer: false, describedByUrl: DESC });
  assert.ok(Array.isArray(ls.linkset));
  const link = ls.linkset[0];
  assert.equal(link.anchor, R);
  assert.deepEqual(link.up, [{ href: P }]);
  assert.deepEqual(link.type, [{ href: LWS + 'DataResource' }]);
  assert.deepEqual(link.describedby, [{ href: DESC }]);
});

test('linkset: container type + no up at storage root', () => {
  const ls = generateLinkset(P, { parentUrl: null, isContainer: true, describedByUrl: DESC });
  assert.deepEqual(ls.linkset[0].type, [{ href: LWS + 'Container' }]);
  assert.equal('up' in ls.linkset[0], false);
});
