// test/mcp-v2-review-fixes.test.js
// Unit coverage for the MCP v2 review-fix round (12 findings). Pure/unit
// checks live here; live-pod behavior stays in the lws-pod make test-mcp-v2 gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUri } from '../src/mcp/uri.js';
import { listResourceTemplates, listFixedResources, RESOLVERS, readResource } from '../src/mcp/resources.js';
import { SURFACE_TEMPLATES, SURFACE_FIXED } from '../src/mcp/surface.js';
import { startLwsPod, ownerCtx, putFile } from './helpers.js';
import { callTool } from '../src/mcp/tools.js';
import { sanitizeTypes } from '../src/mcp/sanitize.js';
import { readDeclaredTypes } from '../src/lws/type-metadata.js';
import * as storage from '../src/storage/filesystem.js';
import { generateOwnerAcl, serializeAcl } from '../src/wac/parser.js';

const RPC = { INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603, ACCESS_DENIED: -32002 };

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

// --- #3: lws://acl of a container addressed without a trailing slash --------

test('#3 lws://acl of a slashless container path reads the ACL that governs it', async (t) => {
  const p = await startLwsPod(t);
  const ctx = ownerCtx(p);
  // Container /notes/ with its OWN acl at /notes/.acl (owner control, so the
  // CONTROL check passes and there is a distinctive authorization to return).
  const container = `/${p.podName}/notes/`;
  await storage.createContainer(container);
  const containerUrl = `${p.origin}${container}`;
  await storage.write(container + '.acl', serializeAcl(generateOwnerAcl(containerUrl, p.webId, true)));

  // Address it WITHOUT the trailing slash — the ACL view must still resolve
  // /notes/.acl, not the non-existent /notes.acl.
  const out = await readResource(`lws://acl/${p.podName}/notes`, ctx);
  const acl = JSON.parse(out.contents[0].text);
  assert.equal(acl.exists, true, 'the container ACL must be found, not reported absent');
  assert.ok(acl.authorizations.length > 0, 'authorizations from /notes/.acl must be returned');
});

// --- #5/#6: large bodies signal truncation + label uses real content type ---

test('#5 lws://resource over 200KB carries an explicit truncation marker', async (t) => {
  const p = await startLwsPod(t);
  const ctx = ownerCtx(p);
  const big = 'x'.repeat(250_000);
  await putFile(p, `/${p.podName}/big.txt`, big);
  const out = await readResource(`lws://resource/${p.podName}/big.txt`, ctx);
  assert.match(out.contents[0].text, /truncat/i, 'a >200KB body must tell the model it is partial');
});

test('#6 the untrusted-content label uses the real content type (getContentType, not a 6-entry map)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = ownerCtx(p);
  await putFile(p, `/${p.podName}/g.trig`, '<a> <b> <c> .');   // .trig ∉ the old 6-entry table
  const out = await readResource(`lws://resource/${p.podName}/g.trig`, ctx);
  assert.match(out.contents[0].text, /application\/trig/, 'label must reflect getContentType, not fall back to text/plain');
});

// --- #8: a real read error on a skill is not masked as not-found ------------

test('#8 lws://skill surfaces a genuine read error instead of masking it as not-found', async (t) => {
  const p = await startLwsPod(t);
  const ctx = ownerCtx(p);
  // A directory at a skill path: exists() is true (so it's NOT missing), but
  // reading it as a file yields null → the old catch reported ACCESS_DENIED
  // "not found", hiding a real 500-class condition.
  await storage.createContainer(`/${p.podName}/skilldir/`);
  await assert.rejects(
    () => readResource(`lws://skill/${p.podName}/skilldir/`, ctx),
    (e) => e.code === RPC.INTERNAL_ERROR,
    'a non-missing skill that fails to read must not be reported as not-found',
  );
});

// --- #2: type/describedby strings are sanitized + write-validated -----------

test('#2 sanitizeTypes strips hidden chars from each type/shape string', () => {
  assert.deepEqual(
    sanitizeTypes(['http://x/a​b', 'http://y/‮z']),
    ['http://x/ab', 'http://y/z'],
  );
  assert.deepEqual(sanitizeTypes(null), []);
});

test('#2 lws://linkset emits sanitized declared types (no bidi/zero-width reaches the model)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = ownerCtx(p);
  await putFile(p, `/${p.podName}/n`, '{}');
  // A hostile type value with a zero-width char, written straight to the
  // server-managed sidecar (the read surface must neutralize it regardless).
  await storage.write(`/${p.podName}/n.lwstypes`, Buffer.from(JSON.stringify(['http://ex/E​vil'])));
  const out = await readResource(`lws://linkset/${p.podName}/n`, ctx);
  assert.doesNotMatch(out.contents[0].text, /​/, 'zero-width char must be stripped from the linkset');
});

test('#2 MCP write validates types to absolute URIs (garbage not persisted)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const res = await callTool('write_resource', {
    path: `/${p.podName}/typed`, content: '{}', contentType: 'application/ld+json',
    types: ['http://ok/T', 'not a uri', 'ftp://x/'],
  }, ctx);
  assert.equal(res.isError, false);
  const stored = await readDeclaredTypes(storage, `/${p.podName}/typed`);
  assert.deepEqual(stored, ['http://ok/T', 'ftp://x/'], 'only absolute-URI types persist; free text is dropped');
});
