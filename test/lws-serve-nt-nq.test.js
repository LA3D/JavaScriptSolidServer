// test/lws-serve-nt-nq.test.js
// Review #6: filesystem/git-seeded .nt/.nq sources must convert on read —
// toDataset routed them to the JSON-LD parser (never parses), and JSON-LD
// was missing from GRAPH_CAPABLE though jsonld.fromRDF is lossless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as storage from '../src/storage/filesystem.js';
import { startTestServer, stopTestServer, request, createTestPod, assertStatus } from './helpers.js';

test('seeded .nq with a named graph: -> ld+json 200 (lossless), -> turtle 406 (lossy)', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('ntnq');
  await storage.write('/ntnq/g.nq', Buffer.from('<http://ex/s> <http://ex/p> "v" <http://ex/g>.\n'));
  const asJson = await request('/ntnq/g.nq', { headers: { Accept: 'application/ld+json' }, auth: 'ntnq' });
  assertStatus(asJson, 200);
  const doc = JSON.parse(await asJson.text());
  assert.match(JSON.stringify(doc), /http:\/\/ex\/g/);       // named graph survives
  const asTtl = await request('/ntnq/g.nq', { headers: { Accept: 'text/turtle' }, auth: 'ntnq' });
  assertStatus(asTtl, 406);                                   // still lossy — teaching 406
});

test('seeded .nt (no graphs): -> turtle 200; named-graph JSON-LD -> ld+json still self-serves', async (t) => {
  await startTestServer({ lws: true, conneg: true });
  t.after(stopTestServer);
  await createTestPod('ntnq2');
  await storage.write('/ntnq2/t.nt', Buffer.from('<http://ex/s> <http://ex/p> "v".\n'));
  const asTtl = await request('/ntnq2/t.nt', { headers: { Accept: 'text/turtle' }, auth: 'ntnq2' });
  assertStatus(asTtl, 200);
  assert.match(await asTtl.text(), /"v"/);
});
