// test/lwsowner-sidecar-authz.test.js
// Governance round: .lwsowner joins the System-Managed sidecar class.
// Write-refused on every surface, READ-gated on the subject, hidden from
// remoteStorage listings — mirrors the .lwstypes/.lwsprov properties.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, ownerCtx } from './helpers.js';
import * as storage from '../src/storage/filesystem.js';
import { writeOwners, ownerStorePath } from '../src/lws/type-metadata.js';
import { callTool } from '../src/mcp/tools.js';

describe('.lwsowner is System-Managed', () => {
  let pod, root;
  before(async (t) => {
    pod = await startLwsPod(t, 'govauthz'); root = `/${pod.podName}/`;
    await writeOwners(storage, root, [pod.webId]);
    // a member-level decoy: mid-name suffix must classify as sidecar too
    await storage.write(`${root}victim.md`, Buffer.from('# v'));
  });

  it('HTTP PUT/PATCH/DELETE of a mid-name .lwsowner are refused (405)', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${pod.base}${root}victim.md.lwsowner`, {
        method, headers: { Authorization: `Bearer ${pod.token}`, 'Content-Type': 'application/json' },
        body: method === 'DELETE' ? undefined : '["https://evil.example/#me"]',
      });
      assert.equal(res.status, 405, `${method} must be refused`);
      assert.equal(await storage.exists(`${root}victim.md.lwsowner`), false);
    }
  });

  it('MCP write_resource / delete_resource refuse .lwsowner', async () => {
    const owner = { ...ownerCtx(pod), lwsEnabled: true };
    const w = await callTool('write_resource', { path: `${root}victim.md.lwsowner`, content: '[]' }, owner);
    assert.ok(w.isError, 'write must error');
    const d = await callTool('delete_resource', { path: `${root}.lwsowner` }, owner);
    assert.ok(d.isError, 'delete must error');
    assert.equal(await storage.exists(ownerStorePath(root)), true);
  });

  it('case-variant suffix still classifies (F1 inheritance)', async () => {
    const res = await fetch(`${pod.base}${root}victim.md.LWSOWNER`, {
      method: 'PUT', headers: { Authorization: `Bearer ${pod.token}`, 'Content-Type': 'application/json' },
      body: '["https://evil.example/#me"]',
    });
    assert.notEqual(res.status, 201, 'case-variant must not create a sidecar-aliasable resource');
  });
});
