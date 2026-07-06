// test/mcp-affordance-federation.test.js
// Federation moves from a God-Tool RPC proxy ({tool, arguments}) to one thin
// affordance-driven read. Task 2 folded that remote-only tool into
// read_resource's one-Web dispatch: read_resource({uri}) is LOCAL when uri
// shares this pod's origin, and federation-gated REMOTE otherwise — GETting
// a remote real-URI resource (including a remote pod's storage description),
// deep-sanitizing it (a remote pod is the least-trusted source), and
// returning it. The agent then operates the remote pod from ITS OWN
// affordances (typed links, @context) — not by RPC-ing an arbitrary named
// tool on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, TOOLS } from '../src/mcp/tools.js';
import { readResource } from '../src/mcp/resources.js';
import { ResourceError } from '../src/mcp/errors.js';
import { startLwsPod, ownerCtx, putFile } from './helpers.js';

test('call_remote_pod and read_remote_resource are both gone; read_resource replaces them', () => {
  assert.equal(TOOLS.call_remote_pod, undefined);
  assert.equal(TOOLS.read_remote_resource, undefined);
  assert.ok(TOOLS.read_resource, 'the one-Web affordance-driven read exists');
});

// The old version of this test used the pod's OWN origin as the "remote" —
// under one-Web dispatch that uri shares ctx.origin, so read_resource now
// dispatches it as a LOCAL read (the local result shape, not the remote
// {url,status,body} envelope). It still proves the content survives the
// read intact; the genuinely-remote arm (foreign origin, federation gate,
// links passthrough) is covered by test/mcp-read-tools.test.js.
test('read_resource local: same-origin uri reads its own public resource (one-Web: same-origin is never federation)', async (t) => {
  const p = await startLwsPod(t);
  await putFile(p, `/${p.podName}/pub.json`, '{"@context":{"ex":"http://ex/"},"ex:k":"v"}', { publicRead: true });
  const ctx = { ...ownerCtx(p), federationDepth: 0, lwsEnabled: true };
  const res = await callTool('read_resource', { uri: `${p.origin}/${p.podName}/pub.json` }, ctx);
  assert.equal(res.isError ?? false, false);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body['ex:k'], 'v');
});

// Carried review Minor: the resources/read foreign-origin steering error (#7,
// mcp-affordance-read.test.js) points agents at "the read_resource
// tool" — this ties that string to the tool actually existing under that
// name, so the two can't drift apart silently.
test('the foreign-origin steering error names a real tool', async (t) => {
  const p = await startLwsPod(t);
  await assert.rejects(
    () => readResource('https://other.example/x', ownerCtx(p)),
    (e) => e instanceof ResourceError && /read_resource/.test(e.message),
  );
  assert.ok(TOOLS.read_resource, 'the steered-to tool actually exists');
});
