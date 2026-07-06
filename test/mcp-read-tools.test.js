// test/mcp-read-tools.test.js
// The model-driven read path (spec 2026-07-06): MCP Resources are
// application-driven (host-staged), so the read/follow loop needs Tools.
// read_resource is one-Web (local -> readResource resolver; remote ->
// federation gate, verbatim); links carries the header-borne affordances
// (JSON-LD 1.1 §6.1/§6.2) that MCP results otherwise strip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteLinks, localLinks } from '../src/mcp/read-tools.js';
import { startLwsPod, ownerCtx } from './helpers.js';

test('parseRemoteLinks extracts json-ld#context, ld+json alternate, and linkset rels', () => {
  const h = '<https://ex.org/ctx.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json", ' +
            '<https://ex.org/alt.jsonld>; rel="alternate"; type="application/ld+json", ' +
            '<https://ex.org/r>; rel="linkset"; type="application/linkset+json", ' +
            '<https://ex.org/other>; rel="stylesheet"';
  assert.deepEqual(parseRemoteLinks(h), {
    context: 'https://ex.org/ctx.jsonld',
    alternate: 'https://ex.org/alt.jsonld',
    linkset: 'https://ex.org/r',
  });
});

test('parseRemoteLinks: alternate without ld+json type is ignored; empty/absent header -> {}', () => {
  assert.deepEqual(parseRemoteLinks('<https://ex.org/a>; rel="alternate"; type="text/html"'), {});
  assert.deepEqual(parseRemoteLinks(null), {});
  assert.deepEqual(parseRemoteLinks(''), {});
});

test('parseRemoteLinks strips hidden/bidi chars from targets (sanitizeField)', () => {
  const h = '<https://ex.org/c‮tx.jsonld>; rel="http://www.w3.org/ns/json-ld#context"';
  assert.equal(parseRemoteLinks(h).context.includes('‮'), false);
});

test('localLinks: file gets up + storageDescription; describedby only when a shape is declared', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };
  const links = await localLinks(`/${pod.podName}/notes/a`, ctx);
  assert.equal(links.up, `${pod.origin}/${pod.podName}/notes/`);
  assert.equal(links.storageDescription, `${pod.origin}/.well-known/lws-storage`);
  assert.equal(links.describedby, undefined);
});

test('localLinks: root has no up', async (t) => {
  const pod = await startLwsPod(t);
  const links = await localLinks('/', { ...ownerCtx(pod), lwsEnabled: true });
  assert.equal(links.up, undefined);
  assert.ok(links.storageDescription);
});
