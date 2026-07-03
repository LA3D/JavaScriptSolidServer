/**
 * MCP skill Resources honor WAC (#task-5).
 *
 * Skill files (read at their real https:// URLs), the skills index
 * (/.well-known/mcp/skills), and pod-info (/.well-known/mcp/pod-info) must
 * gate on the same `wac(ctx, path, AccessMode.READ)` check every other MCP
 * resource resolver uses — "skills are public" is an ACL fact (a public-read
 * ACL on the skill file), not an auth-layer bypass.
 *
 * pod-info was a follow-up finding (formerly the `pod_info` tool): it called
 * readPodSkill() unconditionally and surfaced skill.path/skill.format with no
 * WAC check — an existence/metadata oracle for a pod-wide SKILL file
 * regardless of its ACL. It must report `skill: null` for a caller who can't
 * Read the skill file, same as a pod with no skill at all.
 *
 * These tools were removed in Task 5 (migrated to the Resources primitive,
 * src/mcp/resources.js): `list_skills` -> the skills index, `get_skill` /
 * `get_pod_skill` -> reading the skill file's real URL, `pod_info` ->
 * the pod-info resource.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, putFile, postMcp } from './helpers.js';

async function read(pod, uri) {
  const { body } = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } });
  return body;
}

test('a skill read denies a private path to anonymous', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/private/secret.md', 'top secret', { publicRead: false });
  const body = await read(pod, `${pod.origin}/private/secret.md`);
  assert.ok(body.error);
  assert.match(body.error.message, /access denied/i);
});

test('a skill read allows a public-read skill file', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const body = await read(pod, `${pod.origin}/SKILL.md`);
  assert.ok(!body.error, body.error?.message);
  assert.match(body.result.contents[0].text, /# skill/);
});

test('the pod-wide SKILL.md is denied when not public-read', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: false });
  const body = await read(pod, `${pod.origin}/SKILL.md`);
  assert.ok(body.error);
  assert.match(body.error.message, /access denied/i);
});

test('the pod-wide SKILL.md is allowed when public-read', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const body = await read(pod, `${pod.origin}/SKILL.md`);
  assert.ok(!body.error, body.error?.message);
});

test('the skills index omits skills the caller cannot READ', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: false });
  const body = await read(pod, `${pod.origin}/.well-known/mcp/skills`);
  assert.ok(!body.error, body.error?.message);
  const payload = JSON.parse(body.result.contents[0].text);
  assert.equal(payload['skill:items'].length, 0, 'private pod skill must not be listed to anonymous');
});

test('the skills index includes skills the caller CAN READ', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const body = await read(pod, `${pod.origin}/.well-known/mcp/skills`);
  assert.ok(!body.error, body.error?.message);
  const payload = JSON.parse(body.result.contents[0].text);
  assert.equal(payload['skill:items'].length, 1);
  assert.equal(payload['skill:items'][0]['@id'], '/SKILL.md');
});

test('pod-info reports skill: null when the pod-wide SKILL.md is not public-read (anonymous)', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: false });
  const body = await read(pod, `${pod.origin}/.well-known/mcp/pod-info`);
  assert.ok(!body.error, body.error?.message);
  const payload = JSON.parse(body.result.contents[0].text);
  assert.equal(payload.skill, null, 'anonymous caller must not learn the skill file exists');
});

test('pod-info surfaces skill metadata when the pod-wide SKILL.md is public-read', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const body = await read(pod, `${pod.origin}/.well-known/mcp/pod-info`);
  assert.ok(!body.error, body.error?.message);
  const payload = JSON.parse(body.result.contents[0].text);
  assert.ok(payload.skill, 'skill metadata should be present when readable');
  assert.equal(payload.skill.path, '/SKILL.md');
});
