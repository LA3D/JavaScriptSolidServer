// test/mcp-affordance-promote.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readResource } from '../src/mcp/resources.js';
import { startLwsPod, ownerCtx } from './helpers.js';

test('pod-info advertises the vocab/context locations + steers the agent', async (t) => {
  const p = await startLwsPod(t);
  const out = await readResource(`${p.origin}/.well-known/mcp/pod-info`, ownerCtx(p));
  const info = JSON.parse(out.contents[0].text);
  assert.equal(info.vocabulary, `${p.origin}/.well-known/lws/vocab`);
  assert.equal(info.context, `${p.origin}/.well-known/lws/context`);
  assert.equal(info.storageRoot, `${p.origin}/`);
  assert.match(JSON.stringify(info.hint), /follow|@context|typed link/i);
});
