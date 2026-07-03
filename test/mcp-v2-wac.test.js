import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, parentPath } from '../src/mcp/wac.js';

test('buildUrl joins origin + path, forcing a leading slash', () => {
  const ctx = { origin: 'https://pod.example' };
  assert.equal(buildUrl(ctx, '/a/b'), 'https://pod.example/a/b');
  assert.equal(buildUrl(ctx, 'a/b'), 'https://pod.example/a/b');
});

test('parentPath returns the containing container', () => {
  assert.equal(parentPath('/a/b/c'), '/a/b/');
  assert.equal(parentPath('/a/b/'), '/a/');
  assert.equal(parentPath('/x'), '/');
  assert.equal(parentPath('/'), '/');
});
