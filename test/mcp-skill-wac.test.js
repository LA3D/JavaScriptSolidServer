/**
 * MCP skill tools honor WAC (#task-5).
 *
 * `get_skill` / `get_pod_skill` / `list_skills` must gate on the same
 * `wac(ctx, path, AccessMode.READ)` check every other MCP read tool uses —
 * "skills are public" is an ACL fact (a public-read ACL on the skill file),
 * not an auth-layer bypass.
 *
 * Note: the brief names the read tool `read_skill`; this codebase's actual
 * tool name is `get_skill` (see src/mcp/tools.js TOOLS registry) — tests use
 * the real name.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../src/mcp/tools.js';
import { startServer, putFile } from './helpers.js';

test('get_skill denies a private path to anonymous', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/private/secret.md', 'top secret', { publicRead: false });
  const res = await callTool('get_skill', { path: '/private/secret.md' },
    { webId: null, origin: pod.origin });
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res), /access denied/i);
});

test('get_skill allows a public-read skill file', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const res = await callTool('get_skill', { path: '/SKILL.md' },
    { webId: null, origin: pod.origin });
  assert.equal(res.isError ?? false, false);
});

test('get_pod_skill denies when the pod-wide SKILL.md is not public-read', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: false });
  const res = await callTool('get_pod_skill', {},
    { webId: null, origin: pod.origin });
  assert.equal(res.isError, true);
  assert.match(JSON.stringify(res), /access denied/i);
});

test('get_pod_skill allows when the pod-wide SKILL.md is public-read', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const res = await callTool('get_pod_skill', {},
    { webId: null, origin: pod.origin });
  assert.equal(res.isError ?? false, false);
});

test('list_skills omits skills the caller cannot READ', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: false });
  const res = await callTool('list_skills', {},
    { webId: null, origin: pod.origin });
  assert.equal(res.isError ?? false, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload['skill:items'].length, 0, 'private pod skill must not be listed to anonymous');
});

test('list_skills includes skills the caller CAN READ', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const res = await callTool('list_skills', {},
    { webId: null, origin: pod.origin });
  assert.equal(res.isError ?? false, false);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload['skill:items'].length, 1);
  assert.equal(payload['skill:items'][0]['@id'], '/SKILL.md');
});
