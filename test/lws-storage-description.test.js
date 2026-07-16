import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateStorageDescription, buildStorageDescription, buildStorageDescriptionFor, buildServerIndex, storageDescriptionUrl } from '../src/lws/storage-description.js';

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
    { type: 'NotificationService', serviceEndpoint: ROOT + 'notification/api' },
  ]);
  for (const s of d.service) {
    assert.equal(typeof s.type, 'string');
    assert.equal(typeof s.serviceEndpoint, 'string');
  }
  assert.ok(d.service.some(s => s.type === 'StorageDescription' && s.serviceEndpoint === DESC));
  assert.ok(d.service.some(s => s.type === 'NotificationService'));
});

test('McpService advertised iff MCP is enabled (S5 — /mcp was invisible to HTTP-cold agents)', () => {
  const on = buildStorageDescription('https://pod.example', { mcpEnabled: true });
  const svc = on.service.find(s => s.type === 'McpService');
  assert.ok(svc);
  assert.equal(svc.serviceEndpoint, 'https://pod.example/mcp');
  const off = buildStorageDescription('https://pod.example', {});
  assert.ok(!off.service.some(s => s.type === 'McpService'));
});

// A3 (spec 2026-07-11 §4): Task 5 made the shadowed-container escape TRUE
// (a specific non-HTML Accept now reaches the real listing, root included),
// so the linkset hint must teach the escape instead of a bare "descend".
test('linkset hint teaches the shadow escape (root is listable by conneg)', () => {
  const sd = buildStorageDescription('https://pod.example', {});
  assert.match(sd.linkset.hint, /non-HTML Accept/);
  assert.match(sd.linkset.hint, /application\/lws\+json/);
});

test('TypeSearchService carries a query-syntax hint', () => {
  const sd = buildStorageDescription('https://pod.example', { typeIndexEnabled: true });
  const ts = sd.service.find(s => s.type === 'TypeSearchService');
  assert.match(ts.hint, /\?type=/);
});

// probe #7 batch: a cold agent hitting 429s otherwise has no way to learn the
// budget is per-IP-anonymous, not a pod-wide outage.
test('McpService hint names the anonymous rate-limit budget when anonRateLimitMax is given', () => {
  const sd = buildStorageDescription('https://pod.example', { mcpEnabled: true, anonRateLimitMax: 60 });
  const svc = sd.service.find(s => s.type === 'McpService');
  assert.match(svc.hint, /Anonymous callers: 60 requests\/minute/);
  assert.match(svc.hint, /x-ratelimit/i);
});

test('McpService hint omits the budget sentence when anonRateLimitMax is not given', () => {
  const sd = buildStorageDescription('https://pod.example', { mcpEnabled: true });
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

// buildStorageDescription (origin form) is UNCHANGED by this task — see the
// byte-identity check in the task report. The per-storage `id` and the
// StorageDescription self-pointer land on the new buildStorageDescriptionFor
// instead — every OTHER service stays origin-scoped (controller correction:
// this round adds no per-storage service ROUTES, so e.g. /alice/types/index
// would be a dead endpoint).
test('buildStorageDescriptionFor: id + StorageDescription self-pointer are pod-scoped', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { typeIndexEnabled: true });
  assert.equal(d.id, 'http://h/alice/');
  const sd = d.service.find(s => s.type === 'StorageDescription');
  assert.equal(sd.serviceEndpoint, 'http://h/alice/lws-storage');
});

test('buildStorageDescriptionFor: TypeIndexService/TypeSearchService are ORIGIN-scoped, not pod-scoped', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { typeIndexEnabled: true });
  const ti = d.service.find(s => s.type === 'TypeIndexService');
  assert.equal(ti.serviceEndpoint, 'http://h/types/index');
  const ts = d.service.find(s => s.type === 'TypeSearchService');
  assert.equal(ts.serviceEndpoint, 'http://h/types/search');
});

test('buildStorageDescriptionFor keeps McpService origin-scoped, not storage-scoped', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { mcpEnabled: true });
  const mcp = d.service.find(s => s.type === 'McpService');
  assert.equal(mcp.serviceEndpoint, 'http://h/mcp');
});

// Controller-specified combo: StorageDescription per-storage, TypeIndexService
// + McpService origin-level, all in one call.
test('buildStorageDescriptionFor: self-endpoint per-storage, server-wide services origin-level', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { typeIndexEnabled: true, mcpEnabled: true, voidPath: '/x' });
  const sd = d.service.find(s => s.type === 'StorageDescription');
  assert.equal(sd.serviceEndpoint, 'http://h/alice/lws-storage');
  const ti = d.service.find(s => s.type === 'TypeIndexService');
  assert.equal(ti.serviceEndpoint, 'http://h/types/index');
  const mcp = d.service.find(s => s.type === 'McpService');
  assert.equal(mcp.serviceEndpoint, 'http://h/mcp');
});

test('buildStorageDescriptionFor: ProfileIndexService composes off origin, not the storage base (avoids double /alice/)', () => {
  const d = buildStorageDescriptionFor('http://h/alice/', { profileIndexPath: '/alice/profiles/index.jsonld' });
  const pi = d.service.find(s => s.type === 'ProfileIndexService');
  assert.equal(pi.serviceEndpoint, 'http://h/alice/profiles/index.jsonld');
});

test('buildServerIndex lists storages, not a Storage', () => {
  const idx = buildServerIndex('http://h', [{ root: '/alice/' }, { root: '/bob/' }]);
  assert.equal(idx.type, 'ServerIndex');
  assert.notEqual(idx.type, 'Storage');
  assert.deepEqual(idx.storage.map(s => s.id), ['http://h/alice/', 'http://h/bob/']);
  assert.equal(idx.storage[0].storageDescription, 'http://h/alice/lws-storage');
});
