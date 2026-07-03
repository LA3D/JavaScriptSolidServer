// test/mcp-v2-review-fixes.test.js
// Unit coverage for the MCP v2 review-fix round (12 findings). Pure/unit
// checks live here; live-pod behavior stays in the lws-pod make test-mcp-v2 gate.
// Read-path tests address resources by their REAL https:// URLs (the lws://
// scheme is retired; its parser tests moved to test/mcp-affordance-uri.test.js,
// and the #11 single-registry check retired with the kind registry itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResource } from '../src/mcp/resources.js';
import { startLwsPod, ownerCtx, putFile, putShape } from './helpers.js';
import { callTool } from '../src/mcp/tools.js';
import { sanitizeTypes, sanitizeDeep } from '../src/mcp/sanitize.js';
import { readDeclaredTypes } from '../src/lws/type-metadata.js';
import { ResourceError } from '../src/mcp/errors.js';
import * as storage from '../src/storage/filesystem.js';
import { generateOwnerAcl, serializeAcl } from '../src/wac/parser.js';

const NOTE_SHAPE = {
  '@context': { sh: 'http://www.w3.org/ns/shacl#', ex: 'http://ex/' },
  '@id': 'http://ex/NoteShape', '@type': 'sh:NodeShape',
  'sh:targetClass': { '@id': 'http://ex/Note' },
  'sh:property': {
    '@id': '_:p1', 'sh:path': { '@id': 'http://ex/title' }, 'sh:minCount': 1,
    'sh:severity': { '@id': 'http://www.w3.org/ns/shacl#Violation' },
    'sh:message': 'title required',
  },
};
const note = (base, path, title) => JSON.stringify({
  '@context': { ex: 'http://ex/' }, '@id': `${base}${path}`, '@type': 'ex:Note',
  ...(title ? { 'http://ex/title': title } : {}),
});

// --- #3: the ACL view of a container addressed without a trailing slash -----

test('#3 X.acl of a slashless container path reads the ACL that governs it', async (t) => {
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
  const out = await readResource(`${p.origin}/${p.podName}/notes.acl`, ctx);
  const acl = JSON.parse(out.contents[0].text);
  assert.equal(acl.exists, true, 'the container ACL must be found, not reported absent');
  assert.ok(acl.authorizations.length > 0, 'authorizations from /notes/.acl must be returned');
});

// --- #5/#6: large bodies signal truncation + label uses real content type ---

test('#5 a body read over 200KB carries an explicit truncation marker', async (t) => {
  const p = await startLwsPod(t);
  const ctx = ownerCtx(p);
  const big = 'x'.repeat(250_000);
  await putFile(p, `/${p.podName}/big.txt`, big);
  const out = await readResource(`${p.origin}/${p.podName}/big.txt`, ctx);
  assert.match(out.contents[0].text, /truncat/i, 'a >200KB body must tell the model it is partial');
});

test('#6 the untrusted-content label uses the real content type (getContentType, not a 6-entry map)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = ownerCtx(p);
  await putFile(p, `/${p.podName}/g.trig`, '<a> <b> <c> .');   // .trig ∉ the old 6-entry table
  const out = await readResource(`${p.origin}/${p.podName}/g.trig`, ctx);
  assert.match(out.contents[0].text, /application\/trig/, 'label must reflect getContentType, not fall back to text/plain');
});

// --- #8: the input that used to mask a read error now has a real meaning ----
// The lws://skill resolver whose catch-all masked read failures as not-found
// was retired with the scheme; a directory addressed by its real slashed URL
// is simply a container read — nothing to mask.

test('#8 a directory at a former skill path reads as a container, not a masked error', async (t) => {
  const p = await startLwsPod(t);
  const ctx = ownerCtx(p);
  await storage.createContainer(`/${p.podName}/skilldir/`);
  const out = await readResource(`${p.origin}/${p.podName}/skilldir/`, ctx);
  const rep = JSON.parse(out.contents[0].text);
  assert.equal(rep.type, 'Container', 'a directory resolves as a first-class container view');
});

// --- #2: type/describedby strings are sanitized + write-validated -----------

test('#2 sanitizeTypes strips hidden chars from each type/shape string', () => {
  assert.deepEqual(
    sanitizeTypes(['http://x/a​b', 'http://y/‮z']),
    ['http://x/ab', 'http://y/z'],
  );
  assert.deepEqual(sanitizeTypes(null), []);
});

test('#2 describe_resource emits sanitized declared types (no bidi/zero-width reaches the model)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = ownerCtx(p);
  await putFile(p, `/${p.podName}/n`, '{}');
  // A hostile type value with a zero-width char, written straight to the
  // server-managed sidecar (the read surface must neutralize it regardless).
  // linkset is no longer a resource kind; describe_resource is its carrier.
  await storage.write(`/${p.podName}/n.lwstypes`, Buffer.from(JSON.stringify(['http://ex/E​vil'])));
  const res = await callTool('describe_resource', { path: `/${p.podName}/n` }, ctx);
  assert.equal(res.isError, false, res.content?.[0]?.text);
  assert.doesNotMatch(res.content[0].text, /​/, 'zero-width char must be stripped from the linkset');
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

// --- #1: put_typed_resource must not mutate .meta on a rejected write --------

test('#1 a rejected put_typed_resource leaves the existing .meta intact (no clobber/dangling shape)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const shapeUrl = await putShape(p, `/${p.podName}/shapes/note`, NOTE_SHAPE);
  const metaPath = `/${p.podName}/x.meta`;
  await storage.write(metaPath, Buffer.from(JSON.stringify({ '@id': `${p.base}/${p.podName}/x`, keep: 'ME' })));

  const res = await callTool('put_typed_resource', {
    path: `/${p.podName}/x`, content: note(p.base, `/${p.podName}/x`), // no title → violates
    contentType: 'application/ld+json', describedby: shapeUrl,
  }, ctx);

  assert.equal(res.isError, true, 'shape-violating write is rejected');
  const meta = JSON.parse((await storage.read(metaPath)).toString('utf8'));
  assert.equal(meta.keep, 'ME', 'pre-existing .meta content must survive a rejected write');
  assert.equal(meta.describedby, undefined, 'a rejected write must not leave a dangling describedby');
});

test('#1 a successful put_typed_resource merges describedby without dropping prior .meta keys', async (t) => {
  const p = await startLwsPod(t);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const shapeUrl = await putShape(p, `/${p.podName}/shapes/note`, NOTE_SHAPE);
  const metaPath = `/${p.podName}/y.meta`;
  await storage.write(metaPath, Buffer.from(JSON.stringify({ '@id': `${p.base}/${p.podName}/y`, keep: 'ME' })));

  const res = await callTool('put_typed_resource', {
    path: `/${p.podName}/y`, content: note(p.base, `/${p.podName}/y`, 'hi'), // has title → conforms
    contentType: 'application/ld+json', describedby: shapeUrl,
  }, ctx);

  assert.equal(res.isError, false);
  const meta = JSON.parse((await storage.read(metaPath)).toString('utf8'));
  assert.equal(meta.keep, 'ME', 'prior .meta keys are preserved (merge, not clobber)');
  assert.equal(meta.describedby, shapeUrl, 'the shape is declared on success');
});

// --- #7: federated (read_remote_resource) content is sanitized --------------

test('#7 sanitizeDeep strips hidden chars from every string in a nested payload', () => {
  const dirty = { content: [{ type: 'text', text: 'a​b' }], meta: { k: '‮evil' } };
  assert.deepEqual(sanitizeDeep(dirty), { content: [{ type: 'text', text: 'ab' }], meta: { k: 'evil' } });
});

// --- #9: resource-read failures carry model-readable content, like tools -----

test('#9 a ResourceError carries the same content[] teaching shape as a tool error', async (t) => {
  const p = await startLwsPod(t);
  await putFile(p, `/${p.podName}/secret`, 'x');   // owner-only, no public ACL
  // Anonymous read → denied; the error must expose content[] the model reads.
  await assert.rejects(
    () => readResource(`${p.origin}/${p.podName}/secret`, { origin: p.origin, webId: null }),
    (e) => e instanceof ResourceError
      && Array.isArray(e.data?.content)
      && /access denied/i.test(e.data.content[0].text)
      && e.data.isError === true,
    'resource-read failures must carry isError + content[] like tool errors',
  );
});
