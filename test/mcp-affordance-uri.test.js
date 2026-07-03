// test/mcp-affordance-uri.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uriToPath, isLocalUri } from '../src/mcp/uri.js';

const O = 'https://pod.example';

test('uriToPath maps a local https URL to its pod path', () => {
  assert.equal(uriToPath(O, `${O}/alice/notes/a`), '/alice/notes/a');
  assert.equal(uriToPath(O, `${O}/alice/notes/`), '/alice/notes/');
  assert.equal(uriToPath(O, `${O}/`), '/');
});

test('uriToPath rejects a foreign origin (federation, not a local read)', () => {
  assert.equal(uriToPath(O, 'https://other.example/x'), null);
  assert.equal(isLocalUri(O, 'https://other.example/x'), false);
  assert.equal(isLocalUri(O, `${O}/x`), true);
});

test('uriToPath rejects malformed percent-encoding (invalid-params, not a raw URIError)', () => {
  assert.equal(uriToPath(O, `${O}/dir/50%off`), null);
  assert.equal(uriToPath(O, 'not-a-url'), null);
});

test('uriToPath keeps a valid percent-sequence RAW for single storage-side decode', () => {
  assert.equal(uriToPath(O, `${O}/a%20b`), '/a%20b');
});
