// test/mcp-read-tools.test.js
// The model-driven read path (spec 2026-07-06): MCP Resources are
// application-driven (host-staged), so the read/follow loop needs Tools.
// read_resource is one-Web (local -> readResource resolver; remote ->
// federation gate, verbatim); links carries the header-borne affordances
// (JSON-LD 1.1 §6.1/§6.2) that MCP results otherwise strip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteLinks, localLinks } from '../src/mcp/read-tools.js';
import { callTool, TOOLS, listToolsForRpc } from '../src/mcp/tools.js';
import { readResource } from '../src/mcp/resources.js';
import { ResourceError } from '../src/mcp/errors.js';
import { startLwsPod, ownerCtx, putFile } from './helpers.js';
import { generatePublicReadAcl, serializeAcl } from '../src/wac/parser.js';
import * as storage from '../src/storage/filesystem.js';
import http from 'node:http';

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

test('registry: read_resource + list_resources in, read_remote_resource gone, exactly 10', () => {
  const names = listToolsForRpc().map(t => t.name).sort();
  assert.deepEqual(names, [
    'create_resource', 'delete_resource', 'describe_resource', 'list_resources',
    'lws_type_search', 'put_typed_resource', 'read_resource', 'subscribe',
    'write_acl', 'write_resource',
  ]);
});

test('read_resource local: body block preserves @context; links block carries up + storageDescription', async (t) => {
  const p = await startLwsPod(t);
  await putFile(p, `/${p.podName}/pub.json`, '{"@context":{"ex":"http://ex/"},"ex:k":"v"}', { publicRead: true });
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const res = await callTool('read_resource', { uri: `${p.origin}/${p.podName}/pub.json` }, ctx);
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  const body = JSON.parse(res.content[0].text);
  assert.ok(body['@context']);                                  // structured, not enveloped
  const meta = JSON.parse(res.content[1].text);
  assert.equal(meta.links.up, `${p.origin}/${p.podName}/`);
  assert.equal(meta.links.storageDescription, `${p.origin}/.well-known/lws-storage`);
});

test('read_resource local: WAC denial is a teaching error, not a throw (no-oracle preserved)', async (t) => {
  const p = await startLwsPod(t);
  await putFile(p, `/${p.podName}/private.json`, '{}');          // owner-only
  const anon = { ...ownerCtx(p), webId: null };
  const res = await callTool('read_resource', { uri: `${p.origin}/${p.podName}/private.json` }, anon);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /access denied|not found/i);
});

test('read_resource remote: federation gate blocks anonymous; owner passes and links pass through', async (t) => {
  const p = await startLwsPod(t);
  // A genuinely foreign origin: a stub server on another port serving ordinary
  // JSON + the json-ld#context Link header (JSON-LD 1.1 §6.1).
  const stub = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Link': '<https://ex.org/ctx.jsonld>; rel="http://www.w3.org/ns/json-ld#context"; type="application/ld+json"',
    });
    res.end('{"name":"probe"}');
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  t.after(() => stub.close());
  const url = `http://127.0.0.1:${stub.address().port}/thing.json`;

  const anonRes = await callTool('read_resource', { uri: url }, { ...ownerCtx(p), webId: null, federationDepth: 0 });
  assert.equal(anonRes.isError, true);
  assert.match(anonRes.content[0].text, /federation requires a local WebID/);

  const res = await callTool('read_resource', { uri: url }, { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true });
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.links.context, 'https://ex.org/ctx.jsonld');   // surfaced, not applied
  assert.match(out.body, /probe/);
});

test('read_resource remote: depth cap enforced (verbatim from read_remote_resource)', async (t) => {
  const p = await startLwsPod(t);
  const res = await callTool('read_resource', { uri: 'http://127.0.0.1:1/x' },
    { ...ownerCtx(p), federationDepth: 3 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /federation depth exceeded/);
});

test('list_resources returns the fixed entry resources + the real-URI template', async (t) => {
  const p = await startLwsPod(t);
  const res = await callTool('list_resources', {}, ownerCtx(p));
  const out = JSON.parse(res.content[0].text);
  assert.ok(out.resources.some(r => r.uri === `${p.origin}/.well-known/lws-storage`));
  assert.ok(out.templates[0].uriTemplate.startsWith('https://'));
});

test('resources/read foreign-origin steering error names read_resource (and it exists)', async (t) => {
  const p = await startLwsPod(t);
  await assert.rejects(
    () => readResource('https://other.example/x', ownerCtx(p)),
    (e) => e instanceof ResourceError && /read_resource/.test(e.message),
  );
  assert.ok(TOOLS.read_resource);
  assert.equal(TOOLS.read_remote_resource, undefined);
});

test('read_resource local: a declared describedby shape surfaces in links', async (t) => {
  const p = await startLwsPod(t);
  await putFile(p, `/${p.podName}/shaped.json`, '{"a":1}', { publicRead: true });
  await putFile(p, `/${p.podName}/shaped.json.meta`, JSON.stringify({
    '@context': { describedby: { '@id': 'http://www.w3.org/2007/05/powder-s#describedby', '@type': '@id' } },
    '@id': `${p.origin}/${p.podName}/shaped.json`,
    describedby: 'https://ex.org/shape',
  }), { publicRead: true });
  const res = await callTool('read_resource', { uri: `${p.origin}/${p.podName}/shaped.json` }, { ...ownerCtx(p), lwsEnabled: true });
  const meta = JSON.parse(res.content[1].text);
  assert.deepEqual(meta.links.describedby, ['https://ex.org/shape']);
});

test('GET /mcp answers 405 with Allow: POST (not a misleading 404)', async (t) => {
  const p = await startLwsPod(t);
  const r = await fetch(`${p.origin}/mcp`);
  assert.equal(r.status, 405);
  assert.match(r.headers.get('allow') || '', /POST/);
  const body = await r.json();
  assert.match(body.hint, /POST JSON-RPC/);
});

test('index-shadowed container omits rel="linkset"; plain container keeps it (cold-probe defect c)', async (t) => {
  const p = await startLwsPod(t);
  await putFile(p, `/${p.podName}/shadowed/index.html`, '<html></html>', { publicRead: true });
  await putFile(p, `/${p.podName}/plain/x.txt`, 'x', { publicRead: true });
  // `publicRead` on putFile grants read on the *file*, not the container —
  // the container GET (which is what serves index.html / the listing) is
  // WAC-checked against the container URL itself, and the pod-root default
  // ACL only inherits Read to the owner, not the public (generateOwnerAcl).
  // Grant the containers their own public-read ACL directly so the
  // anonymous fetches below reach handleGet instead of 401ing.
  await storage.write(`/${p.podName}/shadowed/.acl`, serializeAcl(generatePublicReadAcl(`${p.origin}/${p.podName}/shadowed/`)));
  await storage.write(`/${p.podName}/plain/.acl`, serializeAcl(generatePublicReadAcl(`${p.origin}/${p.podName}/plain/`)));
  const shadowed = await fetch(`${p.origin}/${p.podName}/shadowed/`);
  assert.doesNotMatch(shadowed.headers.get('link') || '', /rel="linkset"/);
  assert.match(shadowed.headers.get('link') || '', /storageDescription/);   // still advertised
  const plain = await fetch(`${p.origin}/${p.podName}/plain/`);
  assert.match(plain.headers.get('link') || '', /rel="linkset"/);
});
