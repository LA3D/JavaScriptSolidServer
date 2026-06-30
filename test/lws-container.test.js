import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLwsContainer } from '../src/ldp/container.js';

const C = 'http://localhost:3000/alice/notes/';
const entries = [
  { name: 'a.ttl', isDirectory: false, size: 12, modified: '2026-06-29T00:00:00.000Z' },
  { name: 'sub', isDirectory: true, size: 4096, modified: '2026-06-29T00:00:00.000Z' },
  { name: '.acl', isDirectory: false, size: 1 },        // hidden — must NOT appear
];

test('LWS container: required top-level shape', () => {
  const c = generateLwsContainer(C, entries);
  assert.equal(c['@context'], 'https://www.w3.org/ns/lws/v1');
  assert.equal(c.id, C);
  assert.equal(c.type, 'Container');
  assert.equal(c.totalItems, 2);                         // .acl filtered out
  assert.ok(Array.isArray(c.items));
  assert.equal(c.items.length, 2);
});

test('LWS container: item typing + DataResource mediaType', () => {
  const c = generateLwsContainer(C, entries);
  const data = c.items.find(i => i.id === C + 'a.ttl');
  const cont = c.items.find(i => i.id === C + 'sub/');
  assert.equal(data.type, 'DataResource');
  assert.equal(data.mediaType, 'text/turtle');           // from extension
  assert.equal(data.size, 12);
  assert.equal(data.modified, '2026-06-29T00:00:00.000Z');
  assert.equal(cont.type, 'Container');
  assert.equal(cont.id.endsWith('/'), true);             // containers get a trailing slash
});

test('LWS container: hidden entries are excluded (no .acl leak)', () => {
  const c = generateLwsContainer(C, entries);
  assert.equal(c.items.some(i => i.id.endsWith('.acl')), false);
});
