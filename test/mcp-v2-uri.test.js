import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUri, pathUri, fixedUri } from '../src/mcp/uri.js';

test('parseUri maps a templated URI to kind + path (path keeps slashes)', () => {
  assert.deepEqual(parseUri('lws://resource/alice/notes/a'), { kind: 'resource', path: '/alice/notes/a' });
  assert.deepEqual(parseUri('lws://container/alice/notes/'), { kind: 'container', path: '/alice/notes/' });
  assert.deepEqual(parseUri('lws://linkset/a'), { kind: 'linkset', path: '/a' });
});

test('parseUri maps a fixed URI to { fixed }', () => {
  assert.deepEqual(parseUri('lws://pod-info'), { fixed: 'pod-info' });
  assert.deepEqual(parseUri('lws://storage-description'), { fixed: 'storage-description' });
  assert.deepEqual(parseUri('lws://skills'), { fixed: 'skills' });
});

test('parseUri rejects unknown scheme/kind/name', () => {
  assert.equal(parseUri('http://x/y'), null);
  assert.equal(parseUri('lws://bogus/a'), null);
  assert.equal(parseUri('lws://nope'), null);
  assert.equal(parseUri(42), null);
});

test('pathUri / fixedUri round-trip', () => {
  assert.equal(pathUri('resource', '/a/b'), 'lws://resource/a/b');
  assert.equal(pathUri('resource', 'a/b'), 'lws://resource/a/b');
  assert.equal(fixedUri('pod-info'), 'lws://pod-info');
  assert.deepEqual(parseUri(pathUri('meta', '/a')), { kind: 'meta', path: '/a' });
});
