// test/governance-backfill.test.js
// Governance round: boot self-heal. A pod tree provisioned before the
// marker/owner records existed regains storage discovery + its owner record
// on the next boot — roster-only, merge-not-overwrite, idempotent.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import { createServer as createNetServer } from 'net';
import { createServer } from '../src/server.js';
import * as storage from '../src/storage/filesystem.js';
import {
  readDeclaredTypes, readOwners, typeStorePath, ownerStorePath, LWS_STORAGE,
} from '../src/lws/type-metadata.js';

// Match the pattern in test/idp.test.js / test/well-known-did-nostr.test.js:
// oidc-provider requires an accurate issuer at registration time (before
// listen), so when `idp: true` is requested we must know the port up front
// rather than let listen({port:0}) assign one after the fact.
async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function boot(options = {}) {
  if (options.idp) {
    const port = await getAvailablePort();
    const base = `http://127.0.0.1:${port}`;
    const s = createServer({
      logger: false, forceCloseConnections: true, podCreateRateLimitMax: 1000,
      idpIssuer: base, ...options,
    });
    await s.listen({ port, host: '127.0.0.1' });
    return { s, base };
  }
  const s = createServer({ logger: false, forceCloseConnections: true, podCreateRateLimitMax: 1000, ...options });
  await s.listen({ port: 0, host: '127.0.0.1' });
  return { s, base: `http://127.0.0.1:${s.server.address().port}` };
}

describe('governance backfill (boot self-heal)', () => {
  it('heals a legacy named pod: marker merged, owner recorded, idempotent', async () => {
    await fs.emptyDir('./data');
    const a = await boot({ lws: true, idp: true });
    const res = await fetch(`${a.base}/.pods`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'legacy', email: 'legacy@example.org', password: 'test-pass-1234' }),
    });
    assert.equal(res.status, 201);
    const { webId } = await res.json();
    await a.s.close();

    // Simulate the pre-a8e0c47 tree: no marker (but another declared type
    // that must survive), no owner record.
    await storage.write(typeStorePath('/legacy/'), Buffer.from(JSON.stringify(['https://example.org/Custom'])));
    await fs.remove('./data/legacy/.lwsowner');

    const b = await boot({ lws: true, idp: true });
    await b.s.close();                                   // onReady ran during listen

    const types = await readDeclaredTypes(storage, '/legacy/');
    assert.ok(types.includes(LWS_STORAGE), 'marker healed');
    assert.ok(types.includes('https://example.org/Custom'), 'merge, not overwrite');
    assert.deepEqual(await readOwners(storage, '/legacy/'), [webId], 'owner recorded');

    // Idempotence: a healthy boot changes neither sidecar.
    const before = [
      (await storage.read(typeStorePath('/legacy/'))).toString(),
      (await storage.read(ownerStorePath('/legacy/'))).toString(),
    ];
    const c = await boot({ lws: true, idp: true });
    await c.s.close();
    assert.equal((await storage.read(typeStorePath('/legacy/'))).toString(), before[0]);
    assert.equal((await storage.read(ownerStorePath('/legacy/'))).toString(), before[1]);
    await fs.emptyDir('./data');
  });

  it('heals a legacy mixed-case named pod (case-sensitive-FS regression)', async () => {
    // Username-index keys are lowercased at account creation (idp/accounts.js)
    // but the pod DIRECTORY is created from the raw name (handlers/container.js).
    // The roster must key off account.podName, not the lowercased username.
    await fs.emptyDir('./data');
    const a = await boot({ lws: true, idp: true });
    const res = await fetch(`${a.base}/.pods`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'MixedCase', email: 'mixedcase@example.org', password: 'test-pass-1234' }),
    });
    assert.equal(res.status, 201);
    const { webId } = await res.json();
    await a.s.close();

    // Simulate the pre-a8e0c47 tree: no marker (but another declared type
    // that must survive), no owner record.
    await storage.write(typeStorePath('/MixedCase/'), Buffer.from(JSON.stringify(['https://example.org/Custom'])));
    await fs.remove('./data/MixedCase/.lwsowner');

    const b = await boot({ lws: true, idp: true });
    await b.s.close();                                   // onReady ran during listen

    const types = await readDeclaredTypes(storage, '/MixedCase/');
    assert.ok(types.includes(LWS_STORAGE), 'marker healed');
    assert.ok(types.includes('https://example.org/Custom'), 'merge, not overwrite');
    assert.deepEqual(await readOwners(storage, '/MixedCase/'), [webId], 'owner recorded');
    await fs.emptyDir('./data');
  });

  it('never overwrites an operator-edited .lwsowner', async () => {
    await fs.emptyDir('./data');
    const a = await boot({ lws: true, idp: true });
    const created = await fetch(`${a.base}/.pods`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'edited', email: 'edited@example.org', password: 'test-pass-1234' }),
    });
    assert.equal(created.status, 201);
    await a.s.close();
    const custom = ['https://org.example/steward#it'];
    await storage.write(ownerStorePath('/edited/'), Buffer.from(JSON.stringify(custom)));
    const b = await boot({ lws: true, idp: true });
    await b.s.close();
    assert.deepEqual(await readOwners(storage, '/edited/'), custom);
    await fs.emptyDir('./data');
  });

  it('single-user root pod heals through the profile-card roster branch', async () => {
    await fs.emptyDir('./data');
    const a = await boot({ lws: true, singleUser: true });   // root pod at /
    await a.s.close();
    await fs.remove('./data/.lwstypes');
    await fs.remove('./data/.lwsowner');
    const b = await boot({ lws: true, singleUser: true });
    await b.s.close();
    assert.ok((await readDeclaredTypes(storage, '/')).includes(LWS_STORAGE));
    const owners = await readOwners(storage, '/');
    assert.equal(owners.length, 1);
    assert.match(owners[0], /\/profile\/card(\.jsonld)?#me$/);
    await fs.emptyDir('./data');
  });
});
