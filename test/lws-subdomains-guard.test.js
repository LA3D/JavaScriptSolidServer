// S6 (spec 2026-07-10 §4): urlToStoragePath (src/lws/admission.js) is
// path-mode-only — under --subdomains it drops the pod-name prefix, so BOTH
// SHACL shape resolution (write.js) and the conneg authz filter
// (representations.js) would silently misresolve. Refuse loudly at startup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

test('--lws + --subdomains is refused at startup', async () => {
  await assert.rejects(
    async () => { await createServer({ lws: true, subdomains: true, baseDomain: 'pods.example' }); },
    /path mode only/
  );
});

test('each flag alone still constructs', async () => {
  const a = await createServer({ lws: true });
  await a.close();
  const b = await createServer({ subdomains: true, baseDomain: 'pods.example' });
  await b.close();
});
