import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateStorageDescription, buildStorageDescription } from '../src/lws/storage-description.js';

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
