import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateStorageDescription, buildStorageDescriptionFor, buildServerIndex, storageDescriptionUrl } from '../src/lws/storage-description.js';

const ROOT = 'http://localhost:3000/';
const DESC = 'http://localhost:3000/.well-known/lws-storage';

test('storage description: required top-level shape', () => {
  const d = generateStorageDescription(ROOT, [
    { type: 'StorageDescription', serviceEndpoint: DESC },
  ]);
  assert.equal(d['@context'], 'https://www.w3.org/ns/lws/v1');
  assert.equal(d.id, ROOT);
  assert.equal(d.type, 'Storage');
  assert.ok(Array.isArray(d.service));
});

test('storage description: every service has type + serviceEndpoint', () => {
  const d = generateStorageDescription(ROOT, [
    { type: 'StorageDescription', serviceEndpoint: DESC },
    { type: 'ExampleService', serviceEndpoint: ROOT + 'example/api' },
  ]);
  for (const s of d.service) {
    assert.equal(typeof s.type, 'string');
    assert.equal(typeof s.serviceEndpoint, 'string');
  }
  assert.ok(d.service.some(s => s.type === 'StorageDescription' && s.serviceEndpoint === DESC));
  assert.ok(d.service.some(s => s.type === 'ExampleService'));
});

test('McpService advertised iff MCP is enabled (S5 — /mcp was invisible to HTTP-cold agents)', () => {
  const on = buildStorageDescriptionFor('https://pod.example/', { mcpEnabled: true });
  const svc = on.service.find(s => s.type === 'McpService');
  assert.ok(svc);
  assert.equal(svc.serviceEndpoint, 'https://pod.example/mcp');
  const off = buildStorageDescriptionFor('https://pod.example/', {});
  assert.ok(!off.service.some(s => s.type === 'McpService'));
});

// A3 (spec 2026-07-11 §4): Task 5 made the shadowed-container escape TRUE
// (a specific non-HTML Accept now reaches the real listing, root included),
// so the linkset hint must teach the escape instead of a bare "descend".
test('linkset hint teaches the shadow escape (root is listable by conneg)', () => {
  const sd = buildStorageDescriptionFor('https://pod.example/', {});
  assert.match(sd.linkset.hint, /non-HTML Accept/);
  assert.match(sd.linkset.hint, /application\/lws\+json/);
});

test('TypeSearchService carries a query-syntax hint', () => {
  const sd = buildStorageDescriptionFor('https://pod.example/', { typeIndexEnabled: true });
  const ts = sd.service.find(s => s.type === 'TypeSearchService');
  assert.match(ts.hint, /\?type=/);
});

// probe #7 batch: a cold agent hitting 429s otherwise has no way to learn the
// budget is per-IP-anonymous, not a pod-wide outage.
test('McpService hint names the anonymous rate-limit budget when anonRateLimitMax is given', () => {
  const sd = buildStorageDescriptionFor('https://pod.example/', { mcpEnabled: true, anonRateLimitMax: 60 });
  const svc = sd.service.find(s => s.type === 'McpService');
  assert.match(svc.hint, /Anonymous callers: 60 requests\/minute/);
  assert.match(svc.hint, /x-ratelimit/i);
});

test('McpService hint omits the budget sentence when anonRateLimitMax is not given', () => {
  const sd = buildStorageDescriptionFor('https://pod.example/', { mcpEnabled: true });
  const svc = sd.service.find(s => s.type === 'McpService');
  assert.doesNotMatch(svc.hint, /requests\/minute/);
});

// A4 (multi-tenant storage, additive): storageDescriptionUrl grows a 2nd,
// optional arg — the 1-arg call stays the origin/.well-known form (server
// index / legacy single-storage callers untouched), a per-storage root path
// switches to the per-storage form.
test('storageDescriptionUrl is per-storage when a root is given', () => {
  assert.equal(
    storageDescriptionUrl('http://h/alice/x.ttl', '/alice/'),
    'http://h/alice/lws-storage');
  assert.equal(
    storageDescriptionUrl('http://h/.well-known/x', null),
    'http://h/.well-known/lws-storage');
});

// buildStorageDescriptionFor's `id` and StorageDescription self-pointer are
// pod-scoped. The origin form (buildStorageDescription) was deleted (R9) —
// zero callers since the multi-tenant round.
test('buildStorageDescriptionFor: id + StorageDescription self-pointer are pod-scoped', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { typeIndexEnabled: true });
  assert.equal(d.id, 'http://h/alice/');
  const sd = d.service.find(s => s.type === 'StorageDescription');
  assert.equal(sd.serviceEndpoint, 'http://h/alice/lws-storage');
});

// Services round (R7): TypeIndexService/TypeSearchService flipped from
// origin-scoped to STORAGE-scoped — Task 6's routes now exist at exactly
// these URLs, so advertising them per-storage is no longer a dead endpoint.
test('buildStorageDescriptionFor: TypeIndexService/TypeSearchService are STORAGE-scoped, not origin-scoped', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { typeIndexEnabled: true });
  const ti = d.service.find(s => s.type === 'TypeIndexService');
  assert.equal(ti.serviceEndpoint, 'http://h/alice/types/index');
  const ts = d.service.find(s => s.type === 'TypeSearchService');
  assert.equal(ts.serviceEndpoint, 'http://h/alice/types/search');
});

test('buildStorageDescriptionFor keeps McpService origin-scoped, not storage-scoped', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { mcpEnabled: true });
  const mcp = d.service.find(s => s.type === 'McpService');
  assert.equal(mcp.serviceEndpoint, 'http://h/mcp');
});

// Combo: StorageDescription + TypeIndexService storage-scoped, McpService
// stays origin-level (one gateway per pod), all in one call.
test('buildStorageDescriptionFor: self-endpoint + TypeIndexService storage-scoped, McpService origin-level', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { typeIndexEnabled: true, mcpEnabled: true, voidPath: '/x' });
  const sd = d.service.find(s => s.type === 'StorageDescription');
  assert.equal(sd.serviceEndpoint, 'http://h/alice/lws-storage');
  const ti = d.service.find(s => s.type === 'TypeIndexService');
  assert.equal(ti.serviceEndpoint, 'http://h/alice/types/index');
  const mcp = d.service.find(s => s.type === 'McpService');
  assert.equal(mcp.serviceEndpoint, 'http://h/mcp');
});

test('buildStorageDescriptionFor: ProfileIndexService composes off origin, not the storage base (avoids double /alice/)', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { profileIndexPath: '/alice/profiles/index.jsonld' });
  const pi = d.service.find(s => s.type === 'ProfileIndexService');
  assert.equal(pi.serviceEndpoint, 'http://h/alice/profiles/index.jsonld');
});

// Services round (R7): the interim suppression is lifted — VoidService is
// now a direct per-storage pointer (no 303 indirection through the
// server-wide /.well-known/void route, so no cross-tenant misdirect risk).
test('buildStorageDescriptionFor advertises VoidService as a direct per-storage pointer', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', {
    voidPath: '/alice/profiles/void.jsonld', typeIndexEnabled: true, mcpEnabled: true,
  });
  assert.ok(d.service.some(s => s.type === 'TypeIndexService'));
  assert.ok(d.service.some(s => s.type === 'McpService'));
  const vs = d.service.find(s => s.type === 'VoidService');
  assert.ok(vs, 'per-storage description must advertise VoidService');
  assert.equal(vs.serviceEndpoint, 'http://h/alice/profiles/void.jsonld');
});

test('buildServerIndex lists storages, not a Storage', () => {
  const idx = buildServerIndex('http://h', [{ root: '/alice/' }, { root: '/bob/' }]);
  assert.equal(idx.type, 'ServerIndex');
  assert.notEqual(idx.type, 'Storage');
  assert.deepEqual(idx.storage.map(s => s.id), ['http://h/alice/', 'http://h/bob/']);
  assert.equal(idx.storage[0].storageDescription, 'http://h/alice/lws-storage');
});

describe('per-storage service endpoints (services round)', () => {
  it('type endpoints are storage-scoped, derived from the storage root', () => {
    const sd = buildStorageDescriptionFor('http://h/alice/', { typeIndexEnabled: true });
    assert.equal(sd.service.find(s => s.type === 'TypeIndexService').serviceEndpoint,
      'http://h/alice/types/index');
    assert.equal(sd.service.find(s => s.type === 'TypeSearchService').serviceEndpoint,
      'http://h/alice/types/search');
  });
  it('root-pod form keeps the origin endpoints (same URLs as before)', () => {
    const sd = buildStorageDescriptionFor('http://h/', { typeIndexEnabled: true });
    assert.equal(sd.service.find(s => s.type === 'TypeIndexService').serviceEndpoint,
      'http://h/types/index');
  });
  it('VoidService is restored as a DIRECT per-storage pointer (no 303 route)', () => {
    const sd = buildStorageDescriptionFor('http://h/alice/', { voidPath: '/alice/profiles/void.jsonld' });
    const vs = sd.service.find(s => s.type === 'VoidService');
    assert.equal(vs.serviceEndpoint, 'http://h/alice/profiles/void.jsonld');
    assert.ok(!vs.hint.includes('303'), 'hint must not describe a 303 anymore');
  });
  it('no voidPath -> no VoidService', () => {
    const sd = buildStorageDescriptionFor('http://h/alice/', {});
    assert.equal(sd.service.find(s => s.type === 'VoidService'), undefined);
  });
});

describe('ServerIndex extension service array (services round)', () => {
  it('advertises the cross-storage surfaces when enabled', () => {
    const idx = buildServerIndex('http://h', [{ root: '/alice/' }],
      { typeIndexEnabled: true, mcpEnabled: true, anonRateLimitMax: 60 });
    assert.equal(idx.service.find(s => s.type === 'TypeIndexService').serviceEndpoint, 'http://h/types/index');
    assert.ok(idx.service.find(s => s.type === 'TypeIndexService').hint.includes('ALL storages'));
    assert.equal(idx.service.find(s => s.type === 'TypeSearchService').serviceEndpoint, 'http://h/types/search');
    assert.equal(idx.service.find(s => s.type === 'McpService').serviceEndpoint, 'http://h/mcp');
    assert.equal(idx.service.find(s => s.type === 'NotificationService'), undefined);
  });
  it('no flags -> no service key (pre-round shape preserved)', () => {
    const idx = buildServerIndex('http://h', [{ root: '/alice/' }]);
    assert.equal('service' in idx, false);
  });
});
