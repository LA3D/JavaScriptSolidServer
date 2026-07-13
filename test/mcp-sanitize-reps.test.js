// test/mcp-sanitize-reps.test.js
// Review round B, task 7: three MCP surfaces still handed the model
// client-controlled strings unfenced while adjacent fields already got
// sanitizeTypes/sanitizeField —
//   #3  altr representation descriptors (href/format/profile from a
//       client-managed .meta) surfaced by read_resource's `links` carrier
//       (read-tools.js localLinks) and describe_resource's linkset
//       (tools.js) both reuse readAuthorizedRepresentations, so both sites
//       needed the same fix.
//   #12 lws_type_search's items[] emitted id/type straight from
//       collectAuthorizedResources with no sanitize pass at all.
//   #13 read_resource's mimeType was unconditionally getContentType(path)
//       (extension-derived) — application/octet-stream for containers and
//       extensionless .well-known/* fixed resources, disagreeing with the
//       resources/read primitive's c.mimeType for those same URIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx, putFile } from './helpers.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';
const HIDDEN = /[​‮]/u;

test('altr href/format/profile reach the model stripped of hidden chars (#3, both surfaces)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const path = `/${p.podName}/card.jsonld`;
  const RES = `${p.origin}${path}`;
  await putFile(p, path, JSON.stringify({ '@id': '#it' }), { publicRead: true });
  await putFile(p, path + '.meta', JSON.stringify({
    '@context': { altr: ALTR, dct: DCT },
    '@id': RES,
    'altr:hasRepresentation': {
      '@id': `${RES}.md​`,
      'dct:conformsTo': `http://ex/prof‮`,
      'dct:format': 'text/mark​down',
    },
  }), { publicRead: true });

  const read = await callTool('read_resource', { uri: RES }, ctx);
  assert.equal(read.isError ?? false, false, JSON.stringify(read));
  const meta = JSON.parse(read.content[1].text);
  assert.equal(meta.links.alternates.length, 1, 'alternate must survive the WAC/authz filter to be checked');
  assert.doesNotMatch(JSON.stringify(meta.links), HIDDEN);

  const desc = await callTool('describe_resource', { path }, ctx);
  assert.equal(desc.isError ?? false, false, JSON.stringify(desc));
  assert.equal(desc.content[0].text.match(/alternate/) !== null, true, 'linkset must actually carry the alternate being checked');
  assert.doesNotMatch(desc.content[0].text, HIDDEN);
});

test('lws_type_search items are sanitized (#12)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const dirtyType = 'http://ex/Type​X';
  const w = await callTool('write_resource', {
    path: `/${p.podName}/typed1`, content: '{}',
    contentType: 'application/ld+json', types: [dirtyType],
  }, ctx);
  assert.equal(w.isError ?? false, false, JSON.stringify(w));

  const r = await callTool('lws_type_search', { type: [dirtyType] }, ctx);
  assert.equal(r.isError ?? false, false, JSON.stringify(r));
  const out = JSON.parse(r.content[0].text);
  assert.equal(out.totalItems, 1, 'the dirty type must round-trip through the write path and match at search time');
  assert.doesNotMatch(r.content[0].text, /​/u);
});

test('read_resource mimeType: container -> lws+json, .md keeps text/markdown, .well-known stays lws+json (#13)', async (t) => {
  const p = await startLwsPod(t);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };

  const c = await callTool('read_resource', { uri: `${p.origin}/${p.podName}/` }, ctx);
  const cMeta = JSON.parse(c.content[1].text);
  assert.equal(cMeta.mimeType, 'application/lws+json');

  await putFile(p, `/${p.podName}/n.md`, '# hi');
  const m = await callTool('read_resource', { uri: `${p.origin}/${p.podName}/n.md` }, ctx);
  assert.equal(JSON.parse(m.content[1].text).mimeType, 'text/markdown');

  const wk = await callTool('read_resource', { uri: `${p.origin}/.well-known/lws-storage` }, ctx);
  assert.equal(JSON.parse(wk.content[1].text).mimeType, 'application/lws+json');
});
