// test/lws-post-slugless-rdf.test.js
// Review #9: the server must not assign a name its own gate rejects — a
// slug-less POST of Turtle gets .ttl, N3 gets .n3; JSON-LD stays extensionless
// (legacy shape). N-Quads/N-Triples can't be exercised end-to-end over HTTP:
// canAcceptInput (src/rdf/conneg.js SUPPORTED_INPUT) never accepts them as
// POST/PUT input, --lws or not — a pre-existing gap orthogonal to this gate.
// MCP write tools bypass that HTTP-level check (they call applyLwsWrite
// directly), so the .nq/.nt mapping is exercised there instead, plus a direct
// unit test of extensionForRdfType for the full interface contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, request, createTestPod, assertStatus, startLwsPod, ownerCtx } from './helpers.js';
import { callTool } from '../src/mcp/tools.js';
import { extensionForRdfType } from '../src/lws/write-consistency.js';

test('extensionForRdfType: the full RDF_EXTENSIONS contract', () => {
  assert.equal(extensionForRdfType('text/turtle'), '.ttl');
  assert.equal(extensionForRdfType('text/n3'), '.n3');
  assert.equal(extensionForRdfType('application/n-triples'), '.nt');
  assert.equal(extensionForRdfType('application/n-quads'), '.nq');
  assert.equal(extensionForRdfType('application/ld+json'), ''); // legacy shape, unchanged
  assert.equal(extensionForRdfType('text/plain'), '');
  assert.equal(extensionForRdfType(''), '');
  // params stripped, case-insensitive — same normalization as the gate's main()
  assert.equal(extensionForRdfType('text/turtle; charset=utf-8'), '.ttl');
  assert.equal(extensionForRdfType('TEXT/TURTLE'), '.ttl');
});

test('slug-less POST: turtle -> 201 with a .ttl-named resource that round-trips', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('slugless');
  const r = await request('/slugless/', { method: 'POST', auth: 'slugless',
    headers: { 'Content-Type': 'text/turtle' }, body: '<#s> <http://ex/p> "v".' });
  assertStatus(r, 201);
  const loc = new URL(r.headers.get('location')).pathname;
  assert.match(loc, /\.ttl$/);
  const back = await request(loc, { headers: { Accept: 'text/turtle' }, auth: 'slugless' });
  assertStatus(back, 200);
  assert.match(await back.text(), /"v"/);
});

test('slug-less POST: n3 -> 201 with a .n3-named resource; JSON-LD -> extensionless (unchanged legacy shape)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('slugless2');
  const n3 = await request('/slugless2/', { method: 'POST', auth: 'slugless2',
    headers: { 'Content-Type': 'text/n3' }, body: '<http://ex/s> <http://ex/p> "v".' });
  assertStatus(n3, 201);
  assert.match(new URL(n3.headers.get('location')).pathname, /\.n3$/);
  const jld = await request('/slugless2/', { method: 'POST', auth: 'slugless2',
    headers: { 'Content-Type': 'application/ld+json' }, body: JSON.stringify({ '@id': '#it' }) });
  assertStatus(jld, 201);
  assert.doesNotMatch(new URL(jld.headers.get('location')).pathname, /\.\w+$/);
});

test('MCP create_resource: slug-less Turtle gets a .ttl-named path', async (t) => {
  const pod = await startLwsPod(t, 'slugmcp');
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };
  const res = await callTool('create_resource', {
    container: `/${pod.podName}/`,
    content: '<#s> <http://ex/p> "v".',
    contentType: 'text/turtle',
  }, ctx);
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  assert.match(res.content[0].text, /\.ttl/);
});

// N-Quads is never accepted as HTTP POST/PUT input (SUPPORTED_INPUT in
// src/rdf/conneg.js omits it regardless of --lws), so this exercises the
// mapping via the MCP path, which calls applyLwsWrite directly.
test('MCP create_resource: slug-less N-Quads gets a .nq-named path (HTTP path blocked upstream by canAcceptInput)', async (t) => {
  const pod = await startLwsPod(t, 'slugmcpnq');
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };
  const res = await callTool('create_resource', {
    container: `/${pod.podName}/`,
    content: '<http://ex/s> <http://ex/p> "v" <http://ex/g>.',
    contentType: 'application/n-quads',
  }, ctx);
  assert.equal(res.isError ?? false, false, JSON.stringify(res));
  assert.match(res.content[0].text, /\.nq/);
});
