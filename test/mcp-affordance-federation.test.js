// test/mcp-affordance-federation.test.js
// Federation moves from a God-Tool RPC proxy ({tool, arguments}) to one thin
// affordance-driven read: read_remote_resource({url}) GETs a remote real-URI
// resource (including a remote pod's storage description), deep-sanitizes it
// (a remote pod is the least-trusted source), and returns it. The agent then
// operates the remote pod from ITS OWN affordances (typed links, @context) —
// not by RPC-ing an arbitrary named tool on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, TOOLS } from '../src/mcp/tools.js';
import { readResource } from '../src/mcp/resources.js';
import { ResourceError } from '../src/mcp/errors.js';
import { startLwsPod, ownerCtx, putFile } from './helpers.js';

test('call_remote_pod is gone; read_remote_resource replaces it', () => {
  assert.equal(TOOLS.call_remote_pod, undefined);
  assert.ok(TOOLS.read_remote_resource, 'the thin affordance-driven remote read exists');
});

test('read_remote_resource fetches a remote resource and returns its representation', async (t) => {
  const p = await startLwsPod(t);                      // acts as both caller and remote
  await putFile(p, `/${p.podName}/pub.json`, '{"@context":{"ex":"http://ex/"},"ex:k":"v"}', { publicRead: true });
  const ctx = { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true };
  const res = await callTool('read_remote_resource', { url: `${p.origin}/${p.podName}/pub.json` }, ctx);
  assert.equal(res.isError ?? false, false);
  assert.match(res.content[0].text, /ex:k/);
});

// Carried review Minor: the resources/read foreign-origin steering error (#7,
// mcp-affordance-read.test.js) points agents at "the read_remote_resource
// tool" — this ties that string to the tool actually existing under that
// name, so the two can't drift apart silently.
test('the foreign-origin steering error names a real tool', async (t) => {
  const p = await startLwsPod(t);
  await assert.rejects(
    () => readResource('https://other.example/x', ownerCtx(p)),
    (e) => e instanceof ResourceError && /read_remote_resource/.test(e.message),
  );
  assert.ok(TOOLS.read_remote_resource, 'the steered-to tool actually exists');
});
