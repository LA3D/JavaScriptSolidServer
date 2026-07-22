/**
 * remoteStorage sidecar privilege-escalation regression suite (SEC-1, 2026-07-22).
 *
 * The remoteStorage plugin (src/remotestorage.js, registered unconditionally at
 * src/server.js — "always on, no flag") is the 9th surface of the sidecar-authz class the
 * 2026-07-21 round closed on the HTTP + 4 MCP surfaces. It reaches the SAME `./data` tree the
 * Solid/WAC layer reads ACLs from, but through a bespoke `checkAuth` that never consults WAC:
 *
 *   1. Registered with `ownerWebId: null`, so `checkAuth` authorizes ANY authenticated WebID —
 *      exactly the delegated/MCP tokens in our threat model, not just the owner.
 *   2. `hasDotfile()` rejects only path segments that BEGIN with `.`, so a mid-name sidecar
 *      suffix like `victim.acl` / `victim.meta` / `victim.lwstypes` / `victim.lwsprov` passes.
 *   3. PUT/DELETE write straight to `storage.write` / `storage.remove` — never routed through
 *      the `applyLwsWrite` choke point or any `auxSubject()` classification.
 *
 * Exploit: an authenticated non-owner `PUT /storage/me/private/victim.acl` with a body granting
 * itself acl:Control → then reads/writes `victim` freely; the DELETE variant strips a sibling's
 * restrictive `.acl`; and GET leaks any sidecar's contents to a non-owner.
 *
 * Oracle is `storage.exists` / a byte read of the sidecar — an HTTP status alone cannot observe
 * whether the write/delete actually landed (mirrors the note in test/sidecar-authz.test.js).
 *
 * RED against the unpatched tree by design: that is the vetting.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, putFile, request } from './helpers.js';
import { createToken } from '../src/auth/token.js';
import * as storage from '../src/storage/filesystem.js';
import { auxSubject } from '../src/utils/url.js';

const ATTACKER = 'http://attacker.example/profile/card#me';
const AUX_SUFFIXES = ['acl', 'meta', 'lwstypes', 'lwsprov'];

// An ACL body granting the attacker Control+Read over the sibling it names — the payload a
// PUT-escalation would plant.
const selfGrantingAcl = (subjectUrl) => JSON.stringify({
  '@context': { acl: 'http://www.w3.org/ns/auth/acl#' },
  '@id': '#grab',
  '@type': 'acl:Authorization',
  'acl:agent': { '@id': ATTACKER },
  'acl:accessTo': { '@id': subjectUrl },
  'acl:mode': [{ '@id': 'acl:Control' }, { '@id': 'acl:Read' }],
});

// A restrictive ACL granting ONLY the pod owner full control over the subject — the sidecar a
// DELETE-escalation would try to strip. The attacker must NOT be able to remove it (and, for the
// `.acl` case, must genuinely lack Control BECAUSE this ACL governs the subject).
const ownerOnlyAcl = (subjectUrl, ownerWebId) => JSON.stringify({
  '@context': { acl: 'http://www.w3.org/ns/auth/acl#' },
  '@id': '#owner',
  '@type': 'acl:Authorization',
  'acl:agent': { '@id': ownerWebId },
  'acl:accessTo': { '@id': subjectUrl },
  'acl:mode': [{ '@id': 'acl:Read' }, { '@id': 'acl:Write' }, { '@id': 'acl:Control' }],
});

// remoteStorage runs single-user at username 'me' over the raw ./data root — its
// storage paths (`/private/victim.acl`) are the SAME nodes the Solid layer resolves,
// which is what makes a planted `.acl` an escalation rather than a scratch file.
const rsUrl = (storagePath) => `/storage/me${storagePath}`;
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

describe('remoteStorage sidecar privilege escalation (SEC-1)', () => {
  for (const suffix of AUX_SUFFIXES) {
    test(`PUT /storage/me/private/victim.${suffix} is refused for an authenticated non-owner and plants nothing`, async (t) => {
      const pod = await startLwsPod(t);
      const attacker = createToken(ATTACKER, 3600);
      const sidecarPath = `/private/victim.${suffix}`;

      const res = await request(rsUrl(sidecarPath), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/ld+json', ...bearer(attacker) },
        body: selfGrantingAcl(`${pod.base}/private/victim`),
      });

      assert.ok(res.status === 401 || res.status === 403 || res.status === 404,
        `PUT victim.${suffix} must be refused, got ${res.status}`);
      assert.equal(await storage.exists(sidecarPath), false,
        `no .${suffix} sidecar may exist after a refused remoteStorage PUT`);
    });

    test(`DELETE /storage/me/private/victim.${suffix} cannot strip a sibling sidecar for a non-owner`, async (t) => {
      const pod = await startLwsPod(t);
      const attacker = createToken(ATTACKER, 3600);
      const sidecarPath = `/private/victim.${suffix}`;
      // Seed a restrictive sidecar directly on disk (bypasses HTTP, like the rest of the suite).
      // For the `.acl` case the body must be owner-only: it IS the subject's ACL, so a body that
      // granted the attacker Control would (correctly) let them delete it — no escalation to test.
      const body = suffix === 'acl'
        ? ownerOnlyAcl(`${pod.base}/private/victim`, pod.webId)
        : JSON.stringify({ marker: 'restrictive-sidecar' });
      await putFile(pod, sidecarPath, body);

      const res = await request(rsUrl(sidecarPath), { method: 'DELETE', headers: bearer(attacker) });

      assert.ok(res.status === 401 || res.status === 403 || res.status === 404,
        `DELETE victim.${suffix} must be refused, got ${res.status}`);
      assert.equal(await storage.exists(sidecarPath), true,
        `the .${suffix} sidecar must survive a refused remoteStorage DELETE`);
    });

    test(`GET /storage/me/private/victim.${suffix} does not leak a sidecar to a non-owner`, async (t) => {
      const pod = await startLwsPod(t);
      const attacker = createToken(ATTACKER, 3600);
      const sidecarPath = `/private/victim.${suffix}`;
      const secretMarker = 'SIDECAR-SECRET-BODY';
      await putFile(pod, sidecarPath, JSON.stringify({ marker: secretMarker }));

      const res = await request(rsUrl(sidecarPath), { headers: bearer(attacker) });

      assert.ok(res.status === 401 || res.status === 403 || res.status === 404,
        `GET victim.${suffix} must be refused, got ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes(secretMarker),
        `remoteStorage GET must not leak the .${suffix} sidecar body`);
    });
  }
});

// The gate authorizes rather than blanket-blocks: an agent an ACL grants Control keeps sidecar
// management over remoteStorage, and ordinary (non-sidecar) files are untouched. These are the
// no-over-tightening guards that distinguish the WAC-subject-gate from a blanket suffix block.
describe('remoteStorage sidecar gate preserves legitimate access', () => {
  test('owner holding Control on the subject can PUT/GET/DELETE its .acl', async (t) => {
    const pod = await startLwsPod(t);
    // The subject's own .acl grants the owner Control — so the owner satisfies the CONTROL check
    // the gate binds `.acl` operations to.
    await putFile(pod, '/mine.acl', ownerOnlyAcl(`${pod.base}/mine`, pod.webId));
    const owner = bearer(pod.token);

    const put = await request(rsUrl('/mine.acl'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', ...owner },
      body: ownerOnlyAcl(`${pod.base}/mine`, pod.webId),
    });
    assert.ok(put.status === 200 || put.status === 201, `owner PUT .acl should succeed, got ${put.status}`);

    const get = await request(rsUrl('/mine.acl'), { headers: owner });
    assert.equal(get.status, 200, 'owner GET .acl should succeed');
    assert.ok((await get.text()).includes(pod.webId), 'owner GET .acl returns the ACL body');

    const del = await request(rsUrl('/mine.acl'), { method: 'DELETE', headers: owner });
    assert.equal(del.status, 200, 'owner DELETE .acl should succeed');
    assert.equal(await storage.exists('/mine.acl'), false, 'owner delete removed the .acl');
  });

  test('owner holding Control can create then update a subject .meta', async (t) => {
    const pod = await startLwsPod(t);
    await putFile(pod, '/note', 'note body');
    await putFile(pod, '/note.acl', ownerOnlyAcl(`${pod.base}/note`, pod.webId));
    const owner = bearer(pod.token);

    // Create: no .meta yet → the gate requires CONTROL, which the owner holds.
    const create = await request(rsUrl('/note.meta'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', ...owner },
      body: JSON.stringify({ '@id': `${pod.base}/note`, v: 1 }),
    });
    assert.ok(create.status === 200 || create.status === 201, `owner create .meta should succeed, got ${create.status}`);
    assert.equal(await storage.exists('/note.meta'), true, 'the .meta was created');

    // Update: .meta now exists → the gate requires only WRITE, which the owner also holds.
    const update = await request(rsUrl('/note.meta'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', ...owner },
      body: JSON.stringify({ '@id': `${pod.base}/note`, v: 2 }),
    });
    assert.ok(update.status === 200 || update.status === 201, `owner update .meta should succeed, got ${update.status}`);
  });

  test('a System-Managed .lwstypes is read-only even to the owner, but readable with subject Read', async (t) => {
    const pod = await startLwsPod(t);
    await putFile(pod, '/note', 'note body');
    await putFile(pod, '/note.acl', ownerOnlyAcl(`${pod.base}/note`, pod.webId));
    await putFile(pod, '/note.lwstypes', JSON.stringify({ types: ['http://example.org/T'] }));
    const owner = bearer(pod.token);

    const put = await request(rsUrl('/note.lwstypes'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', ...owner },
      body: JSON.stringify({ types: ['http://evil.example/T'] }),
    });
    assert.equal(put.status, 403, 'System-Managed .lwstypes must reject client writes even from the owner');

    const get = await request(rsUrl('/note.lwstypes'), { headers: owner });
    assert.equal(get.status, 200, 'owner with subject Read can GET the .lwstypes');
    assert.ok((await get.text()).includes('example.org/T'), 'owner GET returns the .lwstypes body');
  });

  test('ordinary (non-sidecar) files are unaffected by the gate', async (t) => {
    const pod = await startLwsPod(t);
    // remoteStorage is single-user: any authenticated WebID may write ordinary files. The gate
    // must not change that — it only binds aux-suffixed sidecars.
    const someone = bearer(createToken(ATTACKER, 3600));

    const put = await request(rsUrl('/public/hello.txt'), {
      method: 'PUT', headers: { 'Content-Type': 'text/plain', ...someone }, body: 'hi',
    });
    assert.ok(put.status === 200 || put.status === 201, `ordinary PUT should succeed, got ${put.status}`);

    const get = await request(rsUrl('/public/hello.txt'));  // /public/ is readable without auth
    assert.equal(get.status, 200, 'ordinary GET should succeed');
    assert.equal(await get.text(), 'hi', 'ordinary file round-trips intact');
  });
});

// Adversarial review follow-up (2026-07-22). The shared classifier `auxSubject` matched the aux
// suffix case-SENSITIVELY, but the storage layer and WAC look up the literal lowercase `.acl`.
// On a case-insensitive volume — the macOS `make up` local rig bind-mounts ./data — `victim.ACL`
// and `victim.acl` are the SAME inode, so an uppercase-suffix write classified as a non-sidecar
// (guard skipped) still lands on the ACL WAC reads = the SEC-1 escalation, re-opened. The fix
// makes classification case-insensitive (fail-safe: anything that LOOKS like a sidecar suffix in
// any case binds the subject's ACL, even on a case-sensitive FS where it is a distinct file).
describe('sidecar classifier is case-insensitive (SEC-1 follow-up F1)', () => {
  for (const [input, kind, subject] of [
    ['/private/victim.ACL', 'acl', '/private/victim'],
    ['/private/victim.Acl', 'acl', '/private/victim'],
    ['/private/victim.META', 'meta', '/private/victim'],
    ['/private/victim.LwsTypes', 'lwstypes', '/private/victim'],
    ['/private/victim.LWSPROV', 'lwsprov', '/private/victim'],
  ]) {
    test(`auxSubject("${input}") classifies as a .${kind} sidecar`, () => {
      const sc = auxSubject(input);
      assert.ok(sc, `${input} must classify as a sidecar`);
      assert.equal(sc.kind, kind, 'kind is normalized to lowercase');
      assert.equal(sc.subject, subject, 'subject is the stripped path');
    });
  }

  // End-to-end: the escalation via an uppercase suffix must be refused. On a case-insensitive FS
  // this is a genuine escalation attempt (victim.ACL === victim.acl); on a case-sensitive FS the
  // guard must still classify and deny it (the write would otherwise land on a distinct file, but
  // classifying-and-denying is the fail-safe that keeps the two platforms behaving identically).
  test('PUT /storage/me/private/victim.ACL is refused for a non-owner and plants no ACL', async (t) => {
    const pod = await startLwsPod(t);
    const attacker = createToken(ATTACKER, 3600);

    const res = await request(rsUrl('/private/victim.ACL'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json', ...bearer(attacker) },
      body: selfGrantingAcl(`${pod.base}/private/victim`),
    });

    assert.ok(res.status === 401 || res.status === 403 || res.status === 404,
      `PUT victim.ACL must be refused, got ${res.status}`);
    assert.equal(await storage.exists('/private/victim.acl'), false, 'no .acl inode may exist (any case)');
    assert.equal(await storage.exists('/private/victim.ACL'), false, 'no .ACL inode may exist (any case)');
  });
});

// Adversarial review follow-up F4 (2026-07-22): the container-listing branch skipped only
// leading-dot entries, so a mid-name sidecar (`readme.txt.acl`, `readme.txt.meta`, …) was emitted
// as a listing item with ETag / Content-Type / Content-Length — an existence+size oracle for a
// sibling's ACL/metadata to anyone who can list the container. Content is guarded on direct GET;
// this closes the residual metadata leak by hiding aux sidecars from listings (they are reserved
// names, never remoteStorage content — matching the main surface, which hides them too).
describe('remoteStorage listings hide aux sidecars (SEC-1 follow-up F4)', () => {
  test('a container listing omits mid-name .acl/.meta/.lwstypes/.lwsprov siblings', async (t) => {
    const pod = await startLwsPod(t);
    await putFile(pod, '/docs/readme.txt', 'hello');
    await putFile(pod, '/docs/readme.txt.acl', selfGrantingAcl(`${pod.base}/docs/readme.txt`));
    await putFile(pod, '/docs/readme.txt.meta', JSON.stringify({ '@id': `${pod.base}/docs/readme.txt` }));
    const owner = bearer(pod.token);

    const res = await request(rsUrl('/docs/'), { headers: owner });
    assert.equal(res.status, 200, 'owner can list the container');
    const listing = await res.json();
    const items = Object.keys(listing.items || {});
    assert.ok(items.includes('readme.txt'), 'the ordinary file is listed');
    assert.ok(!items.some(k => /\.(acl|meta|lwstypes|lwsprov)$/i.test(k)),
      `no aux sidecar may appear in a remoteStorage listing, got ${JSON.stringify(items)}`);
  });
});
