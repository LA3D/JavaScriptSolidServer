/**
 * MCP (Model Context Protocol) server tests.
 *
 * Covers:
 *   - handshake (initialize / tools/list)
 *   - CRUD tools (list, read, write, create, delete, head)
 *   - WAC enforcement (anonymous denied write, owner allowed)
 *
 * Skill discovery (list_skills/get_skill/get_pod_skill -> the skill file's
 * real URL + /.well-known/mcp/skills), pod_info (-> /.well-known/mcp/pod-info),
 * and docs (list_docs/read_docs, dropped entirely) moved out of tools.js in
 * Task 5 — see test/mcp-v2-resources-skill.test.js and mcp-skill-wac.test.js.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  startTestServer,
  stopTestServer,
  request,
  createTestPod,
  getBaseUrl,
  getPodToken
} from './helpers.js';
import { emitChange } from '../src/notifications/events.js';

let token;
let ownerWebId;

async function rpc(body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await request('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (res.status === 204) return { status: 204, body: null };
  const data = await res.json();
  return { status: res.status, body: data };
}

// Read logic moved from tools (read_resource/list_resources/head_resource/
// lws_linkset/read_acl) to the Resources primitive (Task 4, hard break),
// addressed by the pod's real https:// URLs (affordance redesign). This
// helper drives resources/read the same way the removed tool tests did.
async function readResource(uri, opts = {}) {
  const { body } = await rpc({ jsonrpc: '2.0', id: 500, method: 'resources/read', params: { uri } }, opts);
  return body;
}

describe('MCP server (--mcp enabled)', () => {
  before(async () => {
    await startTestServer({ mcp: true });
    const pod = await createTestPod('mcptest');
    token = getPodToken('mcptest');
    ownerWebId = pod.webId;
  });

  after(async () => {
    await stopTestServer();
  });

  it('responds to initialize with protocol version', async () => {
    const { status, body } = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.jsonrpc, '2.0');
    assert.ok(body.result?.protocolVersion);
    assert.strictEqual(body.result.serverInfo.name, 'jss-mcp');
  });

  it('lists tools', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = body.result.tools.map(t => t.name);
    for (const expected of [
      'write_resource', 'create_resource', 'delete_resource',
      'write_acl', 'subscribe', 'lws_type_search', 'read_resource', 'list_resources'
    ]) {
      assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
    for (const removed of [
      'head_resource', 'lws_linkset', 'read_acl',
      'list_skills', 'get_skill', 'get_pod_skill', 'pod_info', 'lws_storage_description',
      'list_docs', 'read_docs', 'call_remote_pod', 'read_remote_resource'
    ]) {
      assert.ok(!names.includes(removed), `tool should have been removed: ${removed}`);
    }
  });

  it('write_resource denied without auth', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'write_resource', arguments: { path: '/mcptest/public/anon.txt', content: 'nope' } }
    });
    assert.ok(body.result?.isError, 'expected isError for anonymous write');
    assert.match(body.result.content[0].text, /denied/i);
  });

  it('write_resource works with owner token', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: {
        name: 'write_resource',
        arguments: { path: '/mcptest/public/hello.txt', content: 'hi', contentType: 'text/plain' }
      }
    }, { token });
    assert.strictEqual(body.result.isError, false, body.result.content?.[0]?.text);
    assert.match(body.result.content[0].text, /wrote/);
  });

  it('a resource URL returns the written content (enveloped as untrusted data)', async () => {
    const body = await readResource(`${getBaseUrl()}/mcptest/public/hello.txt`, { token });
    assert.ok(!body.error, body.error?.message);
    // v2 wraps resource bodies in the untrusted-content envelope (anti prompt-
    // injection) — the payload is inside the fence, not the raw string.
    const text = body.result.contents[0].text;
    assert.match(text, /BEGIN untrusted pod content/);
    assert.match(text, /\nhi\n/);
  });

  it('a container URL lists the container (lws+json items[])', async () => {
    const body = await readResource(`${getBaseUrl()}/mcptest/public/`, { token });
    assert.ok(!body.error, body.error?.message);
    const payload = JSON.parse(body.result.contents[0].text);
    assert.ok(payload.items.some(i => i.id.endsWith('/hello.txt')));
  });

  it('create_resource auto-mints filename', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: {
        name: 'create_resource',
        arguments: { container: '/mcptest/public/', slug: 'minted', content: 'x' }
      }
    }, { token });
    assert.strictEqual(body.result.isError, false);
    assert.match(body.result.content[0].text, /\/mcptest\/public\/minted/);
  });

  it('delete_resource removes the file', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'delete_resource', arguments: { path: '/mcptest/public/hello.txt' } }
    }, { token });
    assert.strictEqual(body.result.isError, false);
    assert.match(body.result.content[0].text, /deleted/);
  });

  it('an X.meta URL denies (no-oracle) on missing target', async () => {
    const body = await readResource(`${getBaseUrl()}/mcptest/public/does-not-exist.meta`, { token });
    assert.ok(body.error, 'expected an RPC error for a missing resource');
  });

  it('the skills index returns the index shape', async () => {
    const body = await readResource(`${getBaseUrl()}/.well-known/mcp/skills`, { token });
    assert.ok(!body.error, body.error?.message);
    const payload = JSON.parse(body.result.contents[0].text);
    assert.strictEqual(payload['@type'], 'skill:SkillIndex');
    assert.ok(Array.isArray(payload['skill:items']));
  });

  it('skill discovery walks per-app SKILL.md containers', async () => {
    // Seed a per-app skill
    await rpc({
      jsonrpc: '2.0', id: 1010, method: 'tools/call',
      params: {
        name: 'write_resource',
        arguments: {
          path: '/mcptest/public/apps/demo/index.html',
          content: '<h1>demo</h1>',
          contentType: 'text/html'
        }
      }
    }, { token });
    await rpc({
      jsonrpc: '2.0', id: 1011, method: 'tools/call',
      params: {
        name: 'write_resource',
        arguments: {
          path: '/mcptest/public/apps/demo/SKILL.md',
          content: '# demo app skill',
          contentType: 'text/markdown'
        }
      }
    }, { token });

    // Now list against the pod root — but list_skills walks /public/apps/
    // and /private/bots/ at the pod root, not inside a named pod. For this
    // test, we just verify the per-app discovery walks containers correctly
    // by reading the /mcptest/public/apps/ container URL directly and
    // confirming "demo" comes back as a Container.
    const body = await readResource(`${getBaseUrl()}/mcptest/public/apps/`, { token });
    assert.ok(!body.error, body.error?.message);
    const payload = JSON.parse(body.result.contents[0].text);
    const demo = payload.items.find(i => i.id.endsWith('/demo/'));
    assert.ok(demo, 'demo container should be listed');
    assert.strictEqual(demo.type, 'Container', 'directories must list as type Container');
  });

  it('rejects unknown method', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 99, method: 'doesnt/exist' });
    assert.strictEqual(body.error?.code, -32601);
  });

  // --- ACL view / write_acl (#496) ---
  // read_acl (tool) was removed in Task 4; its coverage moves to
  // resources/read of the X.acl URL (src/mcp/resources.js:readAclView).

  it('the .acl view returns existing authorizations for /mcptest/public/', async () => {
    const body = await readResource(`${getBaseUrl()}/mcptest/public/.acl`, { token });
    assert.ok(!body.error, body.error?.message);
    const payload = JSON.parse(body.result.contents[0].text);
    assert.strictEqual(payload.exists, true);
    assert.ok(Array.isArray(payload.authorizations));
    assert.ok(payload.authorizations.length > 0, 'should have at least owner auth');
    // Owner auth should include Read, Write, Control
    const ownerAuth = payload.authorizations.find(a => a.modes.includes('Control'));
    assert.ok(ownerAuth, 'owner auth with Control should exist');
  });

  it('write_acl + .acl view round-trip', async () => {
    const auths = [
      {
        agents: ['/mcptest/profile/card.jsonld#me'],
        modes: ['Read', 'Write', 'Control'],
        isDefault: true
      },
      {
        agentClasses: ['acl:AuthenticatedAgent'],
        modes: ['Read', 'Append'],
        isDefault: true
      },
      {
        agentClasses: ['foaf:Agent'],
        modes: ['Read'],
        isDefault: true
      }
    ];
    const wr = await rpc({
      jsonrpc: '2.0', id: 201, method: 'tools/call',
      params: { name: 'write_acl', arguments: { path: '/mcptest/public/', authorizations: auths } }
    }, { token });
    assert.strictEqual(wr.body.result.isError, false, wr.body.result.content?.[0]?.text);

    const rd = await readResource(`${getBaseUrl()}/mcptest/public/.acl`, { token });
    assert.ok(!rd.error, rd.error?.message);
    const payload = JSON.parse(rd.result.contents[0].text);
    assert.strictEqual(payload.authorizations.length, 3);
    // The ACL view returns agentClasses as full URIs (not the tool's compact
    // 'foaf:Agent'/'acl:AuthenticatedAgent' shorthand) — see resources.js.
    const classes = payload.authorizations.flatMap(a => a.agentClasses || []);
    assert.ok(classes.includes('http://www.w3.org/ns/auth/acl#AuthenticatedAgent'));
    assert.ok(classes.includes('http://xmlns.com/foaf/0.1/Agent'));
  });

  it('write_acl refuses to lock caller out (safety)', async () => {
    // Try to write an ACL that grants Control only to a foreign WebID
    // — would lock the caller (mcptest owner) out. Safety should refuse.
    const { body } = await rpc({
      jsonrpc: '2.0', id: 204, method: 'tools/call',
      params: { name: 'write_acl', arguments: {
        path: '/mcptest/public/',
        authorizations: [
          {
            agents: ['https://stranger.example/profile#me'],
            modes: ['Read', 'Write', 'Control'],
            isDefault: true
          }
        ]
      } }
    }, { token });
    assert.ok(body.result.isError);
    assert.match(body.result.content[0].text, /lock the caller out|would not grant Control/i);
  });

  it('write_acl denied without Control', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 203, method: 'tools/call',
      params: { name: 'write_acl', arguments: {
        path: '/mcptest/public/',
        authorizations: [{ agentClasses: ['foaf:Agent'], modes: ['Read'] }]
      } }
    });  // no token
    assert.ok(body.result.isError);
    assert.match(body.result.content[0].text, /control/i);
  });

  it('write_acl on a resource does not lock the owner out (#575)', async () => {
    // Regression: write_acl on a non-container resource used to set
    // accessTo='./', which resolves to the *parent container* rather than
    // the resource, leaving the resource with zero matching authorizations
    // and locking out even the owner who just granted themselves Control.
    const resPath = '/mcptest/public/acl575.txt';
    const cr = await rpc({
      jsonrpc: '2.0', id: 220, method: 'tools/call',
      params: { name: 'write_resource', arguments: { path: resPath, content: 'secret', contentType: 'text/plain' } }
    }, { token });
    assert.strictEqual(cr.body.result.isError, false, cr.body.result.content?.[0]?.text);

    // Grant the owner Read/Write/Control on the resource itself.
    const wr = await rpc({
      jsonrpc: '2.0', id: 221, method: 'tools/call',
      params: { name: 'write_acl', arguments: {
        path: resPath,
        authorizations: [{ agents: [ownerWebId], modes: ['Read', 'Write', 'Control'] }]
      } }
    }, { token });
    assert.strictEqual(wr.body.result.isError, false, wr.body.result.content?.[0]?.text);

    // The ACL view requires Control on the resource. Before the fix the owner
    // was locked out and this was denied; it must now succeed.
    const rd = await readResource(`${getBaseUrl()}${resPath}.acl`, { token });
    assert.ok(!rd.error, 'owner locked out of resource ACL (#575): ' + rd.error?.message);
    const payload = JSON.parse(rd.result.contents[0].text);
    assert.ok(payload.authorizations.some(a => a.modes.includes('Control')),
      'resource ACL should grant the owner Control');
  });

  // --- read_resource's remote arm (#495, retired call_remote_pod's RPC proxy
  // in Task 6, then folded the dedicated read_remote_resource tool into
  // read_resource's one-Web dispatch in Task 2 — a uri sharing this pod's
  // origin is a LOCAL read; any other origin is federation-gated, exactly as
  // read_remote_resource was) ---

  it('read_resource denied without federation gate access (foreign uri)', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 210, method: 'tools/call',
      params: {
        name: 'read_resource',
        arguments: { uri: 'http://example.invalid/x' }
      }
    });  // no token
    assert.ok(body.result.isError);
    // Anonymous → "local WebID identity" error; authenticated-but-not-gated → "federation gate"
    assert.match(body.result.content[0].text, /federation/i);
  });

  it('read_resource local: same-origin uri is a local read now (one-Web dispatch) — also seeds the federation gate ACL the depth-cap test below relies on', async () => {
    // Federation gate lives at <agent-pod>/private/federation/. For the
    // mcptest pod owner that's /mcptest/private/federation/. Create the
    // container, then grant AuthenticatedAgent Write there. This grant is no
    // longer exercised by THIS test's own read (a same-origin uri never
    // reaches the federation arm under one-Web dispatch), but the depth-cap
    // test below reuses this pod/token and needs the gate already open.
    await rpc({
      jsonrpc: '2.0', id: 220, method: 'tools/call',
      params: {
        name: 'create_resource',
        arguments: { container: '/mcptest/private/', slug: 'federation', isContainer: true }
      }
    }, { token });
    await rpc({
      jsonrpc: '2.0', id: 221, method: 'tools/call',
      params: {
        name: 'write_acl',
        arguments: {
          path: '/mcptest/private/federation/',
          authorizations: [
            {
              agents: ['/mcptest/profile/card.jsonld#me'],
              modes: ['Read', 'Write', 'Control'],
              isDefault: true
            }
          ]
        }
      }
    }, { token });

    // Publish a resource under /mcptest/public/, then read it back by its
    // own real URL — same origin as the caller, so read_resource dispatches
    // it as a LOCAL read (one-Web: only a foreign origin is federation).
    const wr = await rpc({
      jsonrpc: '2.0', id: 223, method: 'tools/call',
      params: {
        name: 'write_resource',
        arguments: { path: '/mcptest/public/federated.txt', content: 'federated-hello', contentType: 'text/plain' }
      }
    }, { token });
    assert.strictEqual(wr.body.result.isError, false, wr.body.result.content?.[0]?.text);

    const base = getBaseUrl();
    const { body } = await rpc({
      jsonrpc: '2.0', id: 222, method: 'tools/call',
      params: {
        name: 'read_resource',
        arguments: { uri: `${base}/mcptest/public/federated.txt` }
      }
    }, { token });
    assert.strictEqual(body.result.isError, false, body.result.content?.[0]?.text);
    assert.match(body.result.content[0].text, /federated-hello/);
  });

  it('read_resource remote: depth cap enforced against a genuinely foreign uri', async () => {
    // Force an inbound MCP-Federation-Depth header so the next hop trips MAX.
    // Uses a foreign (different-port) uri — a self-origin uri would dispatch
    // local under one-Web and never reach the federation depth check.
    const res = await request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'MCP-Federation-Depth': '3'  // already at max → next hop would be 4
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 230, method: 'tools/call',
        params: {
          name: 'read_resource',
          arguments: { uri: 'http://127.0.0.1:1/x' }
        }
      })
    });
    const data = await res.json();
    assert.ok(data.result.isError);
    assert.match(data.result.content[0].text, /depth exceeded/);
  });

  // --- subscribe (#494) ---

  it('subscribe streams SSE events on resourceEvents change', async () => {
    // Open the SSE stream
    const res = await fetch(`${getBaseUrl()}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 300, method: 'tools/call',
        params: { name: 'subscribe', arguments: { path: '/mcptest/public/' } }
      })
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    // Read the initial "subscribed" event then trigger a change
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let events = [];

    async function readUntil(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise(r => setTimeout(() => r({ value: null, done: false }), 200))
        ]);
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          // Parse complete SSE events (terminated by \n\n)
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) {
              events.push(JSON.parse(dataLine.slice(6)));
            }
          }
          if (predicate(events)) return;
        }
      }
    }

    await readUntil(e => e.length >= 1);  // wait for "subscribed" event
    assert.ok(events.length >= 1);
    assert.strictEqual(events[0].method, 'notifications/tool_event');
    assert.strictEqual(events[0].params.event.type, 'subscribed');

    // Trigger a change inside scope
    emitChange(`${getBaseUrl()}/mcptest/public/triggered.txt`);

    await readUntil(e => e.some(ev => ev.params?.event?.type === 'resource_changed'), 3000);
    const change = events.find(ev => ev.params?.event?.type === 'resource_changed');
    assert.ok(change, `expected resource_changed event; got ${JSON.stringify(events)}`);
    assert.strictEqual(change.params.event.path, '/mcptest/public/triggered.txt');

    // Clean up: cancel stream
    await reader.cancel();
  });

  it('subscribe filters by scope', async () => {
    const res = await fetch(`${getBaseUrl()}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 301, method: 'tools/call',
        params: { name: 'subscribe', arguments: { path: '/mcptest/public/' } }
      })
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let events = [];

    async function read(ms = 800) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise(r => setTimeout(() => r({ value: null, done: false }), 100))
        ]);
        if (done) break;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) events.push(JSON.parse(dataLine.slice(6)));
          }
        }
      }
    }

    await read(500);  // pick up "subscribed"
    // Out-of-scope change — should NOT trigger an event
    emitChange(`${getBaseUrl()}/mcptest/private/notes/x.txt`);
    await read(500);
    const changes = events.filter(e => e.params?.event?.type === 'resource_changed');
    assert.strictEqual(changes.length, 0, 'out-of-scope change should not emit');

    await reader.cancel();
  });

  it('rejects unknown tool', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0', id: 100, method: 'tools/call',
      params: { name: 'fictional_tool', arguments: {} }
    });
    assert.ok(body.result?.isError);
    assert.match(body.result.content[0].text, /unknown tool/);
  });
});

describe('MCP server disabled (no flag)', () => {
  before(async () => {
    await startTestServer({});
  });

  after(async () => {
    await stopTestServer();
  });

  it('blocks /mcp when flag is off', async () => {
    // Without --mcp, the route isn't registered. The global auth hook fires
    // first on the missing route and rejects (401) since /mcp isn't on the
    // skip list when mcpEnabled is false. Either 401 or 404 is correct
    // "MCP is not available here" behavior; both block tool dispatch.
    const res = await request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    });
    assert.ok(res.status === 404 || res.status === 401, `expected 404 or 401, got ${res.status}`);
  });
});
