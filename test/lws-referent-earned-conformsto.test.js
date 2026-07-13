// test/lws-referent-earned-conformsto.test.js
// Earned conformsTo provenance (Task 2, 2026-07-13): at admission, stamp each
// validated member with the profile its container conforms to, as a
// System-Managed `.lwsprov` sidecar — distinct from the client-managed
// `.meta` dct:conformsTo (declared binding intent). The up-walk stays the
// discovery contract; this is provenance only, additive, never blocks a write.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { startLwsPod, request } from './helpers.js';
import { readProvenance } from '../src/lws/type-metadata.js';
import * as storage from '../src/storage/filesystem.js';

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';
const DCT_CONFORMS = 'http://purl.org/dc/terms/conformsTo';
const PROFILE_URI = 'https://example.org/prof/ex';

// Trivial always-pass shape: targets ex:Thing, declares no sh:property
// constraints, so any ex:Thing instance validates with zero violations —
// admission resolves ('admit'), the SHACL machinery genuinely ran, but
// nothing about the fixture body can fail it.
const ALWAYS_PASS_SHAPE = JSON.stringify({
  '@context': { sh: 'http://www.w3.org/ns/shacl#', ex: 'http://ex/' },
  '@id': 'http://ex/AlwaysPassShape',
  '@type': 'sh:NodeShape',
  'sh:targetClass': { '@id': 'http://ex/Thing' },
});

describe('earned conformsTo provenance', () => {
  let pod;

  before(async (t) => {
    pod = await startLwsPod(t, 'alice');

    // Container to bind.
    const mk = await request('/alice/c/', { method: 'PUT', auth: 'alice' });
    assert.ok(mk.ok, `container create failed: ${mk.status}`);

    // Always-pass shape, extensionless JSON-LD (legacy creation shape).
    const shape = await request('/alice/shapes/AlwaysPass', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: ALWAYS_PASS_SHAPE,
      auth: 'alice',
    });
    assert.ok(shape.ok, `shape PUT failed: ${shape.status}`);

    // Container .meta declares BOTH describedby (member-rule shape) and
    // dct:conformsTo (the profile the container is bound to) — the fixture
    // putContainerMeta() can't produce (describedby only), so PUT directly.
    const meta = await request('/alice/c/.meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@id': `${pod.base}/alice/c/`,
        [DESCRIBEDBY]: { '@id': `${pod.base}/alice/shapes/AlwaysPass` },
        [DCT_CONFORMS]: { '@id': PROFILE_URI },
      }),
      auth: 'alice',
    });
    assert.ok(meta.ok, `.meta PUT failed: ${meta.status}`);
  });

  it('stamps the validating container conformsTo on an admitted member', async () => {
    const put = await request('/alice/c/m', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { ex: 'http://ex/' },
        '@id': `${pod.base}/alice/c/m`,
        '@type': 'ex:Thing',
      }),
      auth: 'alice',
    });
    assert.ok(put.ok, `member PUT failed: ${put.status}`);

    const prov = await readProvenance(storage, '/alice/c/m');
    assert.ok(prov, '.lwsprov sidecar was not written');
    assert.ok(prov.conformsTo.includes(PROFILE_URI), 'earned conformsTo not recorded');
  });

  it('writes no sidecar when the container declares no conformsTo', async () => {
    const mk = await request('/alice/plain/', { method: 'PUT', auth: 'alice' });
    assert.ok(mk.ok, `container create failed: ${mk.status}`);

    const put = await request('/alice/plain/m', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { ex: 'http://ex/' },
        '@id': `${pod.base}/alice/plain/m`,
        '@type': 'ex:Thing',
      }),
      auth: 'alice',
    });
    assert.ok(put.ok, `member PUT failed: ${put.status}`);

    const prov = await readProvenance(storage, '/alice/plain/m');
    assert.equal(prov, null, 'no conformsTo declared -> no .lwsprov sidecar expected');
  });

  // Fix 3 (review): a 'pass' decision (SHACL never ran) must not stamp
  // provenance, even when the container declares conformsTo — "earned" means
  // VALIDATED, not merely non-rejected. This container declares conformsTo
  // but NO describedby, so resolveShapeUrl finds no shape (opt-in miss) and
  // admit() returns 'pass' — the exact case the reviewer called out.
  it('writes no sidecar on a pass decision (conformsTo declared, no resolvable shape)', async () => {
    const mk = await request('/alice/passcase/', { method: 'PUT', auth: 'alice' });
    assert.ok(mk.ok, `container create failed: ${mk.status}`);

    const meta = await request('/alice/passcase/.meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@id': `${pod.base}/alice/passcase/`,
        [DCT_CONFORMS]: { '@id': PROFILE_URI },
      }),
      auth: 'alice',
    });
    assert.ok(meta.ok, `.meta PUT failed: ${meta.status}`);

    const put = await request('/alice/passcase/m', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': { ex: 'http://ex/' },
        '@id': `${pod.base}/alice/passcase/m`,
        '@type': 'ex:Thing',
      }),
      auth: 'alice',
    });
    assert.ok(put.ok, `member PUT failed: ${put.status}`);

    const prov = await readProvenance(storage, '/alice/passcase/m');
    assert.equal(prov, null, "a 'pass' decision (no resolvable shape) must not earn conformsTo provenance");
  });

  // Fix 1 (review — confirmed leak): .lwsprov must be a registered aux
  // suffix, or walkResources() surfaces it as its own resource and it leaks
  // into /types/search (and the MCP resource-discovery walk that shares the
  // same collectAuthorizedResources plumbing).
  it('.lwsprov sidecar does not leak into GET /types/search', async () => {
    const search = await request('/types/search', { auth: 'alice' });
    assert.ok(search.ok, `/types/search failed: ${search.status}`);
    const page = await search.json();
    const leaked = page.items.filter((i) => i.id.endsWith('.lwsprov'));
    assert.deepEqual(leaked, [], `.lwsprov sidecar(s) leaked into /types/search: ${JSON.stringify(leaked)}`);
  });
});
