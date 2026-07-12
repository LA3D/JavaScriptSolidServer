// test/mcp-alternates.test.js
// Task 6 (debt-drain round, probe #7 A2): conneg-by-profile alternates
// surfaced in the MCP links carrier, authz-filtered — read_resource's
// links block and describe_resource's linkset both carry canonical/
// alternate representations declared on a resource's .meta (altr: model),
// plus describe_resource's teaching sentence pointing an agent at
// Accept-Profile. Mirrors the HTTP linkset shape (test/lws-linkset-
// representations.test.js) so the two surfaces can't drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx, putFile } from './helpers.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';

async function seedRepresentations(pod, resPath, altPath, contentProfile, linksProfile, { publicRead = true } = {}) {
  const RES = `${pod.origin}${resPath}`;
  const ALT = `${pod.origin}${altPath}`;
  await putFile(pod, resPath, '# hello', { publicRead });
  await putFile(pod, altPath, '{}', { publicRead });
  await putFile(pod, resPath + '.meta', JSON.stringify({
    '@context': { altr: ALTR, dct: DCT },
    '@id': RES,
    'altr:hasDefaultRepresentation': { '@id': RES, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': contentProfile } },
    'altr:hasRepresentation': { '@id': ALT, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': linksProfile } },
  }), { publicRead: true });
  return { RES, ALT };
}

test('read_resource links carrier surfaces canonical + alternate representations from .meta', async (t) => {
  const p = await startLwsPod(t);
  const CONTENT_P = 'https://profiles.example/content';
  const LINKS_P = 'https://profiles.example/links';
  const { RES, ALT } = await seedRepresentations(p, `/${p.podName}/mem-a.md`, `/${p.podName}/mem-a.links.jsonld`, CONTENT_P, LINKS_P);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const res = await callTool('read_resource', { uri: RES }, ctx);
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  const meta = JSON.parse(res.content[1].text);
  assert.deepEqual(meta.links.canonical, { href: RES, format: 'text/markdown', profile: CONTENT_P });
  assert.equal(meta.links.alternates.length, 1);
  assert.deepEqual(meta.links.alternates[0], { href: ALT, format: 'application/ld+json', profile: LINKS_P });
});

test('read_resource links carrier drops an alternate the caller cannot read (no-oracle)', async (t) => {
  const p = await startLwsPod(t);
  const CONTENT_P = 'https://profiles.example/content';
  const PRIVATE_P = 'https://profiles.example/private';
  const RES_PATH = `/${p.podName}/mem-b.md`;
  const ALT_PATH = `/${p.podName}/mem-b.private.jsonld`;
  const RES = `${p.origin}${RES_PATH}`;
  const ALT = `${p.origin}${ALT_PATH}`;
  await putFile(p, RES_PATH, '# hello', { publicRead: true });
  await putFile(p, ALT_PATH, '{}');           // owner-only, no publicRead grant
  await putFile(p, RES_PATH + '.meta', JSON.stringify({
    '@context': { altr: ALTR, dct: DCT },
    '@id': RES,
    'altr:hasDefaultRepresentation': { '@id': RES, 'dct:format': 'text/markdown', 'dct:conformsTo': { '@id': CONTENT_P } },
    'altr:hasRepresentation': { '@id': ALT, 'dct:format': 'application/ld+json', 'dct:conformsTo': { '@id': PRIVATE_P } },
  }), { publicRead: true });
  const anon = { webId: null, origin: p.origin, lwsEnabled: true, federationDepth: 0 };
  const res = await callTool('read_resource', { uri: RES }, anon);
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  const meta = JSON.parse(res.content[1].text);
  assert.equal(meta.links.canonical.href, RES);   // default always visible — caller already read this resource
  assert.deepEqual(meta.links.alternates, []);     // private alternate dropped, no oracle
});

test('describe_resource surfaces canonical/alternate in the linkset + the Accept-Profile teaching sentence', async (t) => {
  const p = await startLwsPod(t);
  const CONTENT_P = 'https://profiles.example/content';
  const LINKS_P = 'https://profiles.example/links';
  const resPath = `/${p.podName}/mem-c.md`;
  const { RES, ALT } = await seedRepresentations(p, resPath, `/${p.podName}/mem-c.links.jsonld`, CONTENT_P, LINKS_P);
  const ctx = { ...ownerCtx(p), lwsEnabled: true };
  const res = await callTool('describe_resource', { path: resPath }, ctx);
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  const out = JSON.parse(res.content[0].text);
  assert.deepEqual(out.linkset.linkset[0].canonical, [{ href: RES, type: 'text/markdown', formats: CONTENT_P }]);
  assert.deepEqual(out.linkset.linkset[0].alternate, [{ href: ALT, type: 'application/ld+json', formats: LINKS_P }]);
  assert.match(out.hint, /Accept-Profile/);
  assert.match(out.hint, /rel=alternate/);
});
