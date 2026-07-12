import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLwsContainer } from '../src/ldp/container.js';

const C = 'http://localhost:3000/pod/data/';
const entries = [
  { name: 'a.md', isDirectory: false },
  { name: 'a.md.meta', isDirectory: false },  // sidecar with Solid-specific type
  { name: 'photo.jpg', isDirectory: false },
];

test('items[] mediaType: suffixed sidecar (.meta) reports application/ld+json', () => {
  const c = generateLwsContainer(C, entries);
  const metaItem = c.items.find(i => i.id === C + 'a.md.meta');
  assert.equal(metaItem.type, 'DataResource');
  assert.equal(metaItem.mediaType, 'application/ld+json', 'sidecar .meta should map to application/ld+json via getContentType');
});

test('items[] mediaType: regular files still use mime-types (.jpg → image/jpeg)', () => {
  const c = generateLwsContainer(C, entries);
  const jpgItem = c.items.find(i => i.id === C + 'photo.jpg');
  assert.equal(jpgItem.type, 'DataResource');
  assert.equal(jpgItem.mediaType, 'image/jpeg', 'real file extensions still use mime-types fallback');
});

test('items[] mediaType: markdown → text/markdown', () => {
  const c = generateLwsContainer(C, entries);
  const mdItem = c.items.find(i => i.id === C + 'a.md');
  assert.equal(mdItem.mediaType, 'text/markdown', '.md extension resolves via mime-types');
});
