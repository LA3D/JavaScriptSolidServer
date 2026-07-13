/**
 * MCP (Model Context Protocol) plugin.
 *
 * Usage:
 *   createServer({ mcp: true })
 *
 * Endpoint:
 *   POST /mcp  (JSON-RPC 2.0, MCP Streamable HTTP transport)
 *
 * Auth:
 *   Reuses JSS's existing auth chain — Bearer / DPoP / NIP-98 — so
 *   the same WAC rules that gate /public, /private, etc. also gate
 *   tool calls. Anonymous requests get the same WAC treatment as
 *   any other anonymous request.
 *
 * Spec: https://spec.modelcontextprotocol.io/specification/2025-03-26/
 */

import {
  PROTOCOL_VERSION,
  SERVER_INFO,
  RPC_ERRORS,
  rpcResult,
  rpcError
} from './protocol.js';
import { listToolsForRpc, callTool, TOOLS } from './tools.js';
import { readResource } from './resources.js';
import { listFixed, RESOURCE_TEMPLATE } from './surface.js';
import { ResourceError } from './errors.js';
import { getWebIdFromRequestAsync } from '../auth/token.js';
import { hasLwsCidAuth } from '../auth/lws-cid.js';
import { hasSolidOidcAuth } from '../auth/solid-oidc.js';

const ALLOWED_METHODS = new Set([
  'initialize',
  'initialized',
  'notifications/initialized',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'ping'
]);

function originOf(request) {
  const host = request.headers.host || request.hostname;
  const proto = request.protocol || 'http';
  return `${proto}://${host}`;
}

async function dispatch(msg, ctx) {
  const { id, method, params } = msg;

  if (!ALLOWED_METHODS.has(method)) {
    return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `unknown method: ${method}`);
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: SERVER_INFO,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false }
      }
    });
  }

  if (method === 'initialized' || method === 'notifications/initialized') {
    // Notifications carry no id; nothing to return
    return null;
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: listToolsForRpc() });
  }

  if (method === 'resources/templates/list') {
    return rpcResult(id, { resourceTemplates: [RESOURCE_TEMPLATE] });
  }

  if (method === 'resources/list') {
    return rpcResult(id, { resources: listFixed(ctx.origin) });
  }

  if (method === 'resources/read') {
    const uri = params?.uri;
    if (!uri) return rpcError(id, RPC_ERRORS.INVALID_PARAMS, 'resource uri required');
    try {
      const out = await readResource(uri, ctx);
      return rpcResult(id, out);
    } catch (e) {
      if (e instanceof ResourceError) return rpcError(id, e.code, e.message, e.data);
      return rpcError(id, RPC_ERRORS.INTERNAL_ERROR, `resources/read failed: ${e.message}`);
    }
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    if (!toolName) {
      return rpcError(id, RPC_ERRORS.INVALID_PARAMS, 'tool name required');
    }
    const result = await callTool(toolName, toolArgs, ctx);
    return rpcResult(id, result);
  }

  return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `unhandled method: ${method}`);
}

function isStreamingToolCall(body) {
  return body
    && body.method === 'tools/call'
    && body.params?.name
    && TOOLS[body.params.name]
    // Sniff: invoke the handler synchronously so we can detect the
    // `{ stream: true, init, run }` shape. Streaming tools must be
    // pure-synchronous in their shape-decision (no awaits before
    // returning the stream descriptor).
    && (() => {
      try {
        // We can't safely call the handler without a ctx, so we just
        // rely on the tool name being in our streaming-tools set.
        return STREAMING_TOOLS.has(body.params.name);
      } catch { return false; }
    })();
}

const STREAMING_TOOLS = new Set(['subscribe']);

// Credential-tier seam (task-6). 'audience-bound' mode refuses the
// replayable RS256 bearer on /mcp — only an audience-bound credential class
// (LWS-CID or Solid-OIDC DPoP, detected by header shape same as the auth
// dispatch) may proceed. 'trusted-local' (default) accepts anything the
// normal auth chain resolves a webId from, unchanged from today.
function isAudienceBoundCredential(request) {
  return hasLwsCidAuth(request) || hasSolidOidcAuth(request);
}

async function handleStreamingTool(request, reply, body, ctx) {
  const tool = TOOLS[body.params.name];
  let descriptor;
  try {
    descriptor = tool.handler(body.params.arguments || {}, ctx);
  } catch (e) {
    reply.code(500);
    reply.header('Content-Type', 'application/json');
    return rpcError(body.id, RPC_ERRORS.INTERNAL_ERROR, e.message);
  }
  if (!descriptor || descriptor.stream !== true) {
    // Tool decided not to stream after all — emit single-shot response
    reply.header('Content-Type', 'application/json');
    return rpcResult(body.id, descriptor);
  }

  // Switch to SSE
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const controller = new AbortController();
  request.raw.on('close', () => controller.abort());

  const sendEvent = (payload) => {
    if (controller.signal.aborted) return;
    const note = {
      jsonrpc: '2.0',
      method: 'notifications/tool_event',
      params: { tool: body.params.name, event: payload }
    };
    reply.raw.write(`event: notification\ndata: ${JSON.stringify(note)}\n\n`);
  };

  try {
    const initial = await descriptor.init();
    if (initial) sendEvent(initial);
    await descriptor.run(sendEvent, controller.signal);
  } catch (e) {
    sendEvent({ type: 'error', message: e.message });
  } finally {
    if (!controller.signal.aborted) reply.raw.end();
  }
  return reply;
}

/**
 * Register the MCP plugin with Fastify.
 */
export async function mcpPlugin(fastify, options = {}) {
  // Optional per-route config (e.g. `{ config: { rateLimit } }`) threaded in
  // by server.js so /mcp gets the same trust-aware limiter as writes and
  // /types/* — see server.js's mcpRateLimit / fastify.after() wiring.
  const routeOptions = options.routeOptions || {};
  // Credential-tier seam (task-6). Threaded from server.js the same way as
  // routeOptions — createServer({ mcpCredentialPolicy }) -> here.
  const credentialPolicy = options.credentialPolicy || 'trusted-local';
  // Spec §4b: the SAME podConfig instance server.js built for the HTTP
  // storage-description/void routes — sharing it (rather than making a
  // second makePodConfig) is what keeps the HTTP and MCP views of
  // profileIndex/void from ever diverging. options.podConfig is always
  // present (server.js always constructs one); the fallback here only
  // covers direct mcpPlugin-registration call sites (e.g. tests) that don't.
  const podConfig = options.podConfig || { get: async () => ({}) };
  // Threaded from server.js's anonRateLimitMax (same const the HTTP
  // storage-description route reads) so the McpService hint's budget
  // sentence can never drift between the two surfaces (task 6, parity).
  const anonRateLimitMax = options.anonRateLimitMax ?? null;
  // Federation SSRF opt-in (dt8, spec §6) — threaded from server.js's
  // --lws-federation-private the same way as credentialPolicy/podConfig.
  // Off by default; readRemote (read-tools.js) is the only consumer.
  const federationPrivate = options.federationPrivate ?? false;
  fastify.post('/mcp', routeOptions, async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      reply.code(400);
      return rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'expected JSON-RPC body');
    }

    // Identity for tool calls — pulled from the inbound auth on /mcp itself.
    // null webId means "anonymous"; WAC will treat it accordingly.
    const { webId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));

    // Credential-tier seam: in 'audience-bound' mode, refuse a request that
    // isn't carrying one of the audience-bound credential classes — never
    // proceed to dispatch/tool-call. Checked before ctx is built so a batch
    // body's first message doesn't waste dispatch work.
    if (credentialPolicy === 'audience-bound' && !isAudienceBoundCredential(request)) {
      reply.code(401);
      const errId = (!Array.isArray(body) && body && typeof body === 'object') ? (body.id ?? null) : null;
      reply.header('Content-Type', 'application/json');
      return rpcError(errId, RPC_ERRORS.AUTH_REQUIRED,
        'this endpoint requires an audience-bound credential (LWS-CID or Solid-OIDC DPoP)');
    }

    // Federation depth (used by read_resource's remote arm to enforce the cap)
    const depthHdr = request.headers['mcp-federation-depth'];
    const federationDepth = depthHdr ? parseInt(depthHdr, 10) || 0 : 0;

    const { profileIndex, void: voidPath, uriSpaces } = await podConfig.get();
    const lwsEnabled = request.lwsEnabled || false;
    const ctx = {
      webId: webId || null,
      origin: originOf(request),
      federationDepth,
      federationPrivate,
      lwsEnabled,
      typeIndexEnabled: request.typeIndexEnabled || false,
      profileIndexPath: profileIndex || null,
      voidPath: voidPath || null,
      notificationsEnabled: request.notificationsEnabled || false,
      profileConnegEnabled: request.lwsProfileConneg || false,
      referentResolutionEnabled: lwsEnabled && Array.isArray(uriSpaces) && uriSpaces.length > 0,
      anonRateLimitMax
    };

    // Streaming tool? Hand off to SSE handler.
    if (!Array.isArray(body) && isStreamingToolCall(body)) {
      return handleStreamingTool(request, reply, body, ctx);
    }

    // Batch support (array of requests)
    if (Array.isArray(body)) {
      const out = [];
      for (const msg of body) {
        const r = await dispatch(msg, ctx);
        if (r) out.push(r);
      }
      reply.header('Content-Type', 'application/json');
      return out;
    }

    const result = await dispatch(body, ctx);
    if (result === null) {
      // Notification (no response body)
      reply.code(204);
      return null;
    }
    reply.header('Content-Type', 'application/json');
    return result;
  });

  fastify.options('/mcp', async (_request, reply) => {
    reply.header('Allow', 'POST, OPTIONS');
    reply.code(204);
    return null;
  });

  // MCP Streamable HTTP: this server does not offer the GET SSE stream, so a
  // GET answers 405 (spec-prescribed) — never a 404 whose Allow omits POST,
  // which reads as "no MCP here" to a discovering agent (cold-probe defect b).
  fastify.get('/mcp', async (_request, reply) => {
    reply.header('Allow', 'POST, OPTIONS');
    reply.code(405);
    return {
      error: 'method not allowed',
      hint: 'MCP endpoint — POST JSON-RPC 2.0 (protocol 2025-03-26). This server does not offer the GET SSE stream.'
    };
  });
}
