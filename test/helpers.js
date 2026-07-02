/**
 * Test helpers for JavaScript Solid Server
 */

import { createServer } from '../src/server.js';
import fs from 'fs-extra';
import path from 'path';

const TEST_DATA_DIR = './data';

let server = null;
let baseUrl = null;

// Store tokens for pods by name
const podTokens = new Map();

/**
 * Start a test server on a random available port
 * @param {object} options - Server options
 * @param {boolean} options.conneg - Enable content negotiation (default false)
 * @returns {Promise<{server: object, baseUrl: string}>}
 */
export async function startTestServer(options = {}) {
  // Clean up any existing test data
  await fs.emptyDir(TEST_DATA_DIR);

  // Raise the POST /.pods per-IP-per-day cap (shipped default: 1) so suites
  // that create several pods against one loopback IP aren't blocked by the
  // now-armed rate limit. Tests that specifically assert the limit pass their
  // own override. Production keeps the default of 1.
  server = createServer({ logger: false, forceCloseConnections: true, podCreateRateLimitMax: 1000, ...options });
  // Use port 0 to let OS assign available port
  await server.listen({ port: 0, host: '127.0.0.1' });

  const address = server.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;

  return { server, baseUrl };
}

/**
 * Stop the test server
 */
export async function stopTestServer() {
  if (server) {
    await server.close();
    server = null;
  }
  baseUrl = null;
  // Clean up test data
  await fs.emptyDir(TEST_DATA_DIR);
  // Clear tokens
  podTokens.clear();
}

/**
 * Get the base URL
 */
export function getBaseUrl() {
  return baseUrl;
}

/**
 * Create a pod for testing
 * @param {string} name - Pod name
 * @returns {Promise<{webId: string, podUri: string, token: string}>}
 */
export async function createTestPod(name) {
  const res = await fetch(`${baseUrl}/.pods`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });

  if (!res.ok) {
    throw new Error(`Failed to create pod: ${res.status}`);
  }

  const result = await res.json();

  // Store the token for this pod
  if (result.token) {
    podTokens.set(name, result.token);
  }

  return result;
}

/**
 * Get token for a pod
 * @param {string} name - Pod name
 * @returns {string|null}
 */
export function getPodToken(name) {
  return podTokens.get(name) || null;
}

/**
 * Make a request to the test server
 * @param {string} path - URL path
 * @param {object} options - fetch options (can include `auth: 'podname'` for authenticated requests)
 * @returns {Promise<Response>}
 */
export async function request(urlPath, options = {}) {
  const url = urlPath.startsWith('http') ? urlPath : `${baseUrl}${urlPath}`;

  // Handle authentication
  const { auth, ...fetchOptions } = options;
  if (auth) {
    const token = podTokens.get(auth);
    if (token) {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        'Authorization': `Bearer ${token}`
      };
    }
  }

  return fetch(url, fetchOptions);
}

/**
 * Assert response status
 */
export function assertStatus(res, expected, message = '') {
  if (res.status !== expected) {
    throw new Error(`Expected status ${expected}, got ${res.status}. ${message}`);
  }
}

/**
 * Assert response header exists
 */
export function assertHeader(res, header, expected = undefined) {
  const value = res.headers.get(header);
  if (value === null) {
    throw new Error(`Expected header ${header} to exist`);
  }
  if (expected !== undefined && value !== expected) {
    throw new Error(`Expected header ${header} to be "${expected}", got "${value}"`);
  }
  return value;
}

/**
 * Assert response header contains value
 */
export function assertHeaderContains(res, header, substring) {
  const value = res.headers.get(header);
  if (value === null || !value.includes(substring)) {
    throw new Error(`Expected header ${header} to contain "${substring}", got "${value}"`);
  }
  return value;
}

/**
 * Parse JSON-LD from HTML (extracts from script tag)
 */
export function extractJsonLdFromHtml(html) {
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) {
    throw new Error('No JSON-LD found in HTML');
  }
  return JSON.parse(match[1]);
}

// --- LWS test-harness helpers (mirrors the --lws setup in
// test/lws-type-index.test.js / test/lws-admission-put.test.js, packaged so
// tests that call MCP tools directly via `callTool()` — bypassing the /mcp
// HTTP route — can build a ctx and provision shapes/.meta with one line). ---

/**
 * Start a --lws test server + one pod, and register teardown on `t` (the
 * node:test TestContext) via t.after(). Returns a pod handle: { base, token,
 * webId, podName }. All paths passed to putShape/putContainerMeta/callTool
 * must include the podName prefix (storage paths always do, non-subdomain).
 */
export async function startLwsPod(t, name = 'lwsmcp') {
  await startTestServer({ lws: true });
  const pod = await createTestPod(name);
  const token = getPodToken(name);
  const base = getBaseUrl();
  if (t && typeof t.after === 'function') {
    t.after(async () => { await stopTestServer(); });
  }
  return { base, token, webId: pod.webId, podName: name };
}

/** Build an MCP tool ctx for the pod owner. Caller sets `lwsEnabled`. */
export function ownerCtx(pod) {
  return { webId: pod.webId, origin: pod.base, federationDepth: 0 };
}

/** PUT a SHACL shape (JSON-LD object) at `path` (pod-relative, e.g. `/lwsmcp/shapes/note`). */
export async function putShape(pod, path, shapeJsonLd) {
  const url = `${pod.base}${path.startsWith('/') ? path : '/' + path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json', Authorization: `Bearer ${pod.token}` },
    body: JSON.stringify(shapeJsonLd),
  });
  if (!res.ok) throw new Error(`putShape ${path} failed: ${res.status}`);
  return url;
}

/**
 * Ensure `containerPath` (pod-relative, trailing /) exists and PUT its
 * .meta declaring `describedby` (pod-relative shape path or absolute URL).
 */
export async function putContainerMeta(pod, containerPath, { describedby }) {
  const containerUrl = `${pod.base}${containerPath}`;
  const mk = await fetch(containerUrl, { method: 'PUT', headers: { Authorization: `Bearer ${pod.token}` } });
  if (!mk.ok) throw new Error(`putContainerMeta: container create ${containerPath} failed: ${mk.status}`);
  const shapeUrl = describedby.startsWith('http')
    ? describedby
    : `${pod.base}${describedby.startsWith('/') ? describedby : '/' + describedby}`;
  const res = await fetch(`${containerUrl}.meta`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json', Authorization: `Bearer ${pod.token}` },
    body: JSON.stringify({
      '@id': containerUrl,
      'http://www.w3.org/2007/05/powder-s#describedby': { '@id': shapeUrl },
    }),
  });
  if (!res.ok) throw new Error(`putContainerMeta ${containerPath} failed: ${res.status}`);
}
