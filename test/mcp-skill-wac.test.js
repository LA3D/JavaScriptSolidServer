/**
 * MCP skill Resources honor WAC (#task-5).
 *
 * `lws://skill/{+path}` / `lws://skills` / `lws://pod-info` must gate on the
 * same `wac(ctx, path, AccessMode.READ)` check every other MCP resource
 * resolver uses — "skills are public" is an ACL fact (a public-read ACL on
 * the skill file), not an auth-layer bypass.
 *
 * `lws://pod-info` was a follow-up finding (formerly the `pod_info` tool): it
 * called readPodSkill() unconditionally and surfaced skill.path/skill.format
 * with no WAC check — an existence/metadata oracle for a pod-wide SKILL file
 * regardless of its ACL. It must report `skill: null` for a caller who can't
 * Read the skill file, same as a pod with no skill at all.
 *
 * These tools were removed in Task 5 (migrated to the Resources primitive,
 * src/mcp/resources.js): `list_skills` -> `lws://skills`, `get_skill` ->
 * `lws://skill/{+path}`, `get_pod_skill` -> read `lws://skill/{+path}` on the
 * pod-wide path directly, `pod_info` -> `lws://pod-info`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, putFile, postMcp } from './helpers.js';

async function read(pod, uri) {
  const { body } = await postMcp(pod, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } });
  return body;
}

test('lws://skill denies a private path to anonymous', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/private/secret.md', 'top secret', { publicRead: false });
  const body = await read(pod, 'lws://skill/private/secret.md');
  assert.ok(body.error);
  assert.match(body.error.message, /access denied/i);
});

test('lws://skill allows a public-read skill file', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const body = await read(pod, 'lws://skill/SKILL.md');
  assert.ok(!body.error, body.error?.message);
  assert.match(body.result.contents[0].text, /# skill/);
});

test('lws://skill (pod-wide path) denies when the pod-wide SKILL.md is not public-read', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: false });
  const body = await read(pod, 'lws://skill/SKILL.md');
  assert.ok(body.error);
  assert.match(body.error.message, /access denied/i);
});

test('lws://skill (pod-wide path) allows when the pod-wide SKILL.md is public-read', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const body = await read(pod, 'lws://skill/SKILL.md');
  assert.ok(!body.error, body.error?.message);
});

test('lws://skills omits skills the caller cannot READ', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: false });
  const body = await read(pod, 'lws://skills');
  assert.ok(!body.error, body.error?.message);
  const payload = JSON.parse(body.result.contents[0].text);
  assert.equal(payload['skill:items'].length, 0, 'private pod skill must not be listed to anonymous');
});

test('lws://skills includes skills the caller CAN READ', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const body = await read(pod, 'lws://skills');
  assert.ok(!body.error, body.error?.message);
  const payload = JSON.parse(body.result.contents[0].text);
  assert.equal(payload['skill:items'].length, 1);
  assert.equal(payload['skill:items'][0]['@id'], '/SKILL.md');
});

test('lws://pod-info reports skill: null when the pod-wide SKILL.md is not public-read (anonymous)', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: false });
  const body = await read(pod, 'lws://pod-info');
  assert.ok(!body.error, body.error?.message);
  const payload = JSON.parse(body.result.contents[0].text);
  assert.equal(payload.skill, null, 'anonymous caller must not learn the skill file exists');
});

test('lws://pod-info surfaces skill metadata when the pod-wide SKILL.md is public-read', async (t) => {
  const pod = await startServer(t, { mcp: true });
  await putFile(pod, '/SKILL.md', '# skill', { publicRead: true });
  const body = await read(pod, 'lws://pod-info');
  assert.ok(!body.error, body.error?.message);
  const payload = JSON.parse(body.result.contents[0].text);
  assert.ok(payload.skill, 'skill metadata should be present when readable');
  assert.equal(payload.skill.path, '/SKILL.md');
});
