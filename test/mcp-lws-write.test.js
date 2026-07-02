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
import { startLwsPod, ownerCtx, putShape, putContainerMeta } from './helpers.js';

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
