// test/mcp-v2-review-fixes.test.js
// Unit coverage for the MCP v2 review-fix round (12 findings). Pure/unit
// checks live here; live-pod behavior stays in the lws-pod make test-mcp-v2 gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUri } from '../src/mcp/uri.js';
import { listResourceTemplates, listFixedResources, RESOLVERS } from '../src/mcp/resources.js';
import { SURFACE_TEMPLATES, SURFACE_FIXED } from '../src/mcp/surface.js';

// --- #4: malformed percent-encoding in an lws:// path -----------------------

test('#4 parseUri rejects a malformed percent-sequence (no raw URIError downstream)', () => {
  // A lone/invalid % would reach decodeURIComponent in the storage layer and
  // throw URIError → -32603. parseUri must reject it up front → invalid-params.
  assert.equal(parseUri('lws://resource/dir/50%off'), null);
  assert.equal(parseUri('lws://resource/a%'), null);
  assert.equal(parseUri('lws://resource/a%zz'), null);
});

test('#4 parseUri still accepts a valid percent-sequence (keeps it raw for storage)', () => {
  assert.deepEqual(parseUri('lws://resource/a%20b'), { kind: 'resource', path: '/a%20b' });
});

// --- #11: one declarative registry, no hand-synced tables -------------------

test('#11 the parse set, dispatch map, and advertisement all derive from one registry', () => {
  const metaKinds = SURFACE_TEMPLATES.map(t => t.kind).sort();
  const resolverKinds = Object.keys(RESOLVERS.KIND).sort();
  const advertisedKinds = listResourceTemplates()
    .map(t => t.uriTemplate.replace('lws://', '').split('/')[0]).sort();
  assert.deepEqual(resolverKinds, metaKinds, 'every template kind has a resolver and vice versa');
  assert.deepEqual(advertisedKinds, metaKinds, 'advertisement matches the registry');

  const metaFixed = SURFACE_FIXED.map(f => f.name).sort();
  const resolverFixed = Object.keys(RESOLVERS.FIXED).sort();
  const advertisedFixed = listFixedResources().map(r => r.uri.replace('lws://', '')).sort();
  assert.deepEqual(resolverFixed, metaFixed, 'every fixed name has a resolver and vice versa');
  assert.deepEqual(advertisedFixed, metaFixed, 'fixed advertisement matches the registry');
});
