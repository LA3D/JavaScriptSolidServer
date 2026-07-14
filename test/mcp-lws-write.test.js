/**
 * MCP writes must route through the shared LWS admission core
 * (applyLwsWrite), not bypass it via a direct storage.write. Closes the
 * finding that write_resource/create_resource ignored SHACL admission
 * entirely when --lws was on.
 *
 * Calls `callTool()` directly (not the /mcp HTTP route) so the ctx —
 * including the `lwsEnabled` flag threaded in Task 2 — can be built by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx, putShape, putContainerMeta, request, createTestPod } from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

// Explicit @id on the sh:property blank node — without it JSS's JSON-LD→quads
// conversion orphans the restriction and every resource admits regardless of
// its content (see lws-admission-put.test.js for the same convention).
const NOTE_SHAPE = {
  '@context': { sh: 'http://www.w3.org/ns/shacl#', ex: 'http://ex/' },
  '@id': 'http://ex/NoteShape',
  '@type': 'sh:NodeShape',
  'sh:targetClass': { '@id': 'http://ex/Note' },
  'sh:property': {
    '@id': '_:p1',
    'sh:path': { '@id': 'http://ex/title' },
    'sh:minCount': 1,
    'sh:severity': { '@id': 'http://www.w3.org/ns/shacl#Violation' },
    'sh:message': 'title required',
  },
};

test('write_resource of a non-conforming body is rejected with violations', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };
  await putShape(pod, `/${pod.podName}/shapes/note`, NOTE_SHAPE);
  await putContainerMeta(pod, `/${pod.podName}/notes/`, { describedby: `/${pod.podName}/shapes/note` });

  const res = await callTool('write_resource', {
    path: `/${pod.podName}/notes/bad`,
    content: JSON.stringify({
      '@context': { ex: 'http://ex/' },
      '@id': `${pod.base}/${pod.podName}/notes/bad`,
      '@type': 'ex:Note',
    }),
    contentType: 'application/ld+json',
  }, ctx);

  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res), /violation/i);
});

test('write_resource of a conforming body admits and captures types', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };
  await putShape(pod, `/${pod.podName}/shapes/note`, NOTE_SHAPE);
  await putContainerMeta(pod, `/${pod.podName}/notes/`, { describedby: `/${pod.podName}/shapes/note` });

  const res = await callTool('write_resource', {
    path: `/${pod.podName}/notes/ok`,
    content: JSON.stringify({
      '@context': { ex: 'http://ex/' },
      '@id': `${pod.base}/${pod.podName}/notes/ok`,
      '@type': 'ex:Note',
      'ex:title': 'hi',
    }),
    contentType: 'application/ld+json',
    types: ['http://ex/Note'],
  }, ctx);

  assert.equal(res.isError ?? false, false, JSON.stringify(res));
});

test('write_resource is unaffected by admission when lwsEnabled is false (additive gate)', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: false };
  await putShape(pod, `/${pod.podName}/shapes/note`, NOTE_SHAPE);
  await putContainerMeta(pod, `/${pod.podName}/notes/`, { describedby: `/${pod.podName}/shapes/note` });

  const res = await callTool('write_resource', {
    path: `/${pod.podName}/notes/bad2`,
    content: JSON.stringify({ '@context': { ex: 'http://ex/' }, '@type': 'ex:Note' }),
    contentType: 'application/ld+json',
  }, ctx);

  assert.equal(res.isError ?? false, false, JSON.stringify(res));
});

test('create_resource (non-container) routes through admission', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };
  await putShape(pod, `/${pod.podName}/shapes/note`, NOTE_SHAPE);
  await putContainerMeta(pod, `/${pod.podName}/notes2/`, { describedby: `/${pod.podName}/shapes/note` });

  // slug fixes the minted filename so the content's @id can match the
  // resource URL applyLwsWrite validates against (subjects need an explicit
  // @id for the JSON-LD→quads conversion to attach rdf:type correctly — same
  // orphaning caveat as the shape's sh:property blank node).
  const bad = await callTool('create_resource', {
    container: `/${pod.podName}/notes2/`,
    slug: 'bad',
    content: JSON.stringify({
      '@context': { ex: 'http://ex/' },
      '@id': `${pod.base}/${pod.podName}/notes2/bad`,
      '@type': 'ex:Note',
    }),
    contentType: 'application/ld+json',
  }, ctx);
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad), /violation/i);

  const ok = await callTool('create_resource', {
    container: `/${pod.podName}/notes2/`,
    slug: 'ok',
    content: JSON.stringify({
      '@context': { ex: 'http://ex/' },
      '@id': `${pod.base}/${pod.podName}/notes2/ok`,
      '@type': 'ex:Note',
      'ex:title': 'hi',
    }),
    contentType: 'application/ld+json',
    types: ['http://ex/Note'],
  }, ctx);
  assert.equal(ok.isError ?? false, false, JSON.stringify(ok));
});

test('create_resource container-creation branch is unaffected (no body to admit)', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };
  const res = await callTool('create_resource', {
    container: `/${pod.podName}/`,
    slug: 'newcontainer',
    isContainer: true,
  }, ctx);
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
});

// --- Task 3: System-Managed sidecars are read-only to clients ---

test('write_resource cannot overwrite a System-Managed .lwstypes sidecar', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };

  const res = await callTool('write_resource', {
    path: `/${pod.podName}/notes/subject.lwstypes`,
    content: JSON.stringify(['https://example.org/ex#Injected']),
    contentType: 'application/json',
  }, ctx);

  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res), /System-Managed/i);
});

test('delete_resource cannot delete a System-Managed .lwstypes sidecar', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };

  const res = await callTool('delete_resource', {
    path: `/${pod.podName}/notes/subject.lwstypes`,
  }, ctx);

  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res), /System-Managed/i);
});

// --- I1 (whole-branch review, 2026-07-14): MCP write to a private member's
// .meta must bind the SUBJECT's ACL (WRITE on X), not the sidecar's own path
// (which resolves the container default). This is the MCP twin of the HTTP
// authorizeSidecarAccess .meta fix (Task 1) — the "middleware enforces, MCP
// bypasses" bug class. ---

// Overwrite /lwsmcp/public/.acl to grant alice Control and bob Write on the
// CONTAINER (both accessTo + default), so the buggy container-default
// resolution WOULD authorize bob to write a private member's .meta.
async function grantBobContainerWrite(pod, bob) {
  const base = pod.base;
  const cUrl = `${base}/${pod.podName}/public/`;
  const containerAcl = {
    '@context': { acl: 'http://www.w3.org/ns/auth/acl#', foaf: 'http://xmlns.com/foaf/0.1/' },
    '@graph': [
      { '@id': '#owner', '@type': 'acl:Authorization', 'acl:agent': { '@id': pod.webId },
        'acl:accessTo': { '@id': cUrl }, 'acl:default': { '@id': cUrl },
        'acl:mode': [{ '@id': 'acl:Read' }, { '@id': 'acl:Write' }, { '@id': 'acl:Control' }] },
      { '@id': '#bob', '@type': 'acl:Authorization', 'acl:agent': { '@id': bob.webId },
        'acl:accessTo': { '@id': cUrl }, 'acl:default': { '@id': cUrl },
        'acl:mode': [{ '@id': 'acl:Read' }, { '@id': 'acl:Write' }] },
    ],
  };
  const res = await request(`/${pod.podName}/public/.acl`, {
    method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: pod.podName,
    body: serializeAcl(containerAcl),
  });
  assert.ok(res.ok, `container .acl PUT ${res.status}`);
}

test('I1: MCP write to a private member .meta binds the subject ACL, not the container default', async (t) => {
  const pod = await startLwsPod(t);                       // alice = pod owner ('lwsmcp')
  const bob = await createTestPod('bob');
  const base = pod.base;
  const MEMBER = `/${pod.podName}/public/secret.jsonld`;
  const ownerC = { ...ownerCtx(pod), lwsEnabled: true };
  const bobC = { webId: bob.webId, origin: base, lwsEnabled: true, federationDepth: 0 };

  // alice creates a private member with its OWN tighter ACL (alice-only).
  const put = await request(MEMBER, {
    method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: pod.podName,
    body: JSON.stringify({ '@id': `${base}${MEMBER}#it`, '@type': 'https://ex/Note', 'http://purl.org/dc/terms/title': 'secret' }),
  });
  assert.ok([200, 201, 204].includes(put.status), `member PUT ${put.status}`);
  const memberAcl = await request(`${MEMBER}.acl`, {
    method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: pod.podName,
    body: serializeAcl(generatePrivateAcl(`${base}${MEMBER}`, pod.webId, false)),
  });
  assert.ok([200, 201, 204].includes(memberAcl.status), `member .acl PUT ${memberAcl.status}`);
  await grantBobContainerWrite(pod, bob);

  const metaBody = JSON.stringify({
    '@id': `${base}${MEMBER}`,
    'http://purl.org/dc/terms/conformsTo': { '@id': 'https://ex/prof/injected' },
  });

  // bob is a delegated CONTAINER writer with NO grant on the member's own
  // tighter .acl. RED (pre-fix): container-default resolution authorizes the
  // write -> succeeds (governance hijack). GREEN (post-fix): the .meta write
  // binds the member's ACL -> denied.
  const bobRes = await callTool('write_resource', {
    path: `${MEMBER}.meta`, content: metaBody, contentType: 'application/ld+json',
  }, bobC);
  assert.equal(bobRes.isError, true, `bob (container-writer, no grant on the member) must be denied: ${JSON.stringify(bobRes)}`);
  assert.match(JSON.stringify(bobRes), /access denied/i);

  // NO OVER-BLOCK: alice (owner, WRITE on the member via its own .acl) still
  // writes the member's .meta — the WAC gate lets her through (any downstream
  // result is fine as long as it isn't an access denial).
  const aliceRes = await callTool('write_resource', {
    path: `${MEMBER}.meta`, content: metaBody, contentType: 'application/ld+json',
  }, ownerC);
  assert.ok(!/access denied/i.test(JSON.stringify(aliceRes)), `owner must not be access-denied writing its own .meta: ${JSON.stringify(aliceRes)}`);
});
