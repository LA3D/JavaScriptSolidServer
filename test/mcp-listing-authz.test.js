// test/mcp-listing-authz.test.js
// S1 parity for the MCP surface (spec 2026-07-10 §4, task-12): the MCP
// container view (resources/read on a container URI) must WAC-filter
// membership per requester too — the same choke point (filterReadableEntries,
// src/lws/authorized-listing.js) the HTTP listing path uses
// (test/lws-listing-authz.test.js). Hide, never 401 — no discovery oracle.
//
// Unlike the HTTP call site, the MCP filter is applied UNCONDITIONALLY (not
// gated on --lws/--public): src/mcp/wac.js's wac() already enforces real WAC
// on every read regardless of those flags (no bypass exists on the MCP
// surface), and readContainerView always renders the lws+json items[] shape
// — neither of the HTTP call site's two exceptions ("--public has no WAC to
// filter by", "--lws off keeps the upstream unfiltered listing") applies
// here. The last test below proves that directly (mcp:true, no --lws).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startTestServer, stopTestServer, request, createTestPod, getBaseUrl, postMcp,
} from './helpers.js';
import { generatePrivateAcl, serializeAcl } from '../src/wac/parser.js';

const OPEN = '/alice/public/mcp-listing-open.jsonld';
const PRIV = '/alice/public/mcp-listing-private.jsonld';

async function seed(alice, base) {
  await request(OPEN, {
    method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
    body: JSON.stringify({ '@id': `${base}${OPEN}`, note: 'open' }),
  });
  await request(PRIV, {
    method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
    body: JSON.stringify({ '@id': `${base}${PRIV}`, note: 'private' }),
  });
  // Owner-only resource ACL overrides the /public/ folder's inherited
  // default read (resource ACL wins — src/wac/checker.js findApplicableAcl).
  const aclRes = await request(`${PRIV}.acl`, {
    method: 'PUT', headers: { 'Content-Type': 'application/ld+json' }, auth: 'alice',
    body: serializeAcl(generatePrivateAcl(`${base}${PRIV}`, alice.webId, false)),
  });
  assert.ok([200, 201, 204].includes(aclRes.status));
}

async function readContainerMcp(base, token) {
  const { body } = await postMcp({ origin: base },
    { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: `${base}/alice/public/` } },
    token ? { Authorization: `Bearer ${token}` } : {});
  return body;
}

describe('MCP container listing is WAC-filtered (--lws --mcp)', () => {
  let alice, base;
  before(async () => {
    await startTestServer({ lws: true, mcp: true, conneg: true });
    alice = await createTestPod('alice');
    base = getBaseUrl();
    await seed(alice, base);
  });
  after(async () => { await stopTestServer(); });

  it('anonymous resources/read of the container omits the protected member', async () => {
    const body = await readContainerMcp(base);
    assert.equal(body.error, undefined, JSON.stringify(body));
    const listing = JSON.parse(body.result.contents[0].text);
    assert.ok(listing.items.some((i) => i.id.endsWith('mcp-listing-open.jsonld')));
    assert.equal(listing.items.some((i) => i.id.endsWith('mcp-listing-private.jsonld')), false);
  });

  it('the owner still sees both members', async () => {
    const body = await readContainerMcp(base, alice.token);
    const listing = JSON.parse(body.result.contents[0].text);
    assert.ok(listing.items.some((i) => i.id.endsWith('mcp-listing-open.jsonld')));
    assert.ok(listing.items.some((i) => i.id.endsWith('mcp-listing-private.jsonld')));
  });

  it('HTTP and MCP listings agree on the visible set (S1 parity)', async () => {
    const httpRes = await request('/alice/public/', { headers: { Accept: 'application/ld+json' } });
    const httpBody = await httpRes.text();
    const mcpBody = await readContainerMcp(base);
    const mcpListing = JSON.parse(mcpBody.result.contents[0].text);
    const mcpNames = mcpListing.items.map((i) => i.id.split('/').pop());

    assert.ok(httpBody.includes('mcp-listing-open'));
    assert.ok(!httpBody.includes('mcp-listing-private'));
    assert.ok(mcpNames.includes('mcp-listing-open.jsonld'));
    assert.equal(mcpNames.includes('mcp-listing-private.jsonld'), false);
  });
});

// The MCP surface is mounted with --mcp alone, independent of --lws — prove
// the listing filter isn't accidentally gated on request.lwsEnabled the way
// the HTTP call site is (src/handlers/resource.js: `if (request.lwsEnabled
// && !request.config?.public)`).
describe('MCP container listing is WAC-filtered even without --lws', () => {
  let alice, base;
  before(async () => {
    await startTestServer({ mcp: true });
    alice = await createTestPod('alice');
    base = getBaseUrl();
    await seed(alice, base);
  });
  after(async () => { await stopTestServer(); });

  it('anonymous resources/read still omits the protected member', async () => {
    const body = await readContainerMcp(base);
    const listing = JSON.parse(body.result.contents[0].text);
    assert.ok(listing.items.some((i) => i.id.endsWith('mcp-listing-open.jsonld')));
    assert.equal(listing.items.some((i) => i.id.endsWith('mcp-listing-private.jsonld')), false);
  });
});
