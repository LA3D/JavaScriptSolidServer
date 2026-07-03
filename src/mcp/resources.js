// src/mcp/resources.js
// Declarative resource registry for the MCP Resources primitive. Read-only,
// URI-addressed, WAC-checked, sanitized (sanitize wiring in Task 8). Every
// resolver reuses the same read logic + wac() as the former read tools, so
// the no-oracle property is inherited, not reimplemented.
import { parseUri, pathUri, fixedUri } from './uri.js';
import { wac } from './wac.js';
import { ResourceError } from './errors.js';
import { RPC_ERRORS } from './protocol.js';
import { AccessMode } from '../wac/parser.js';
import { readPodSkill } from './skills.js';

// --- template + fixed advertisement -----------------------------------------

export function listResourceTemplates() {
  return [
    { uriTemplate: 'lws://resource/{+path}', name: 'resource', description: 'A resource body (any content type), enveloped as untrusted data.', mimeType: 'text/plain' },
    { uriTemplate: 'lws://container/{+path}', name: 'container', description: 'A container listing (ldp:contains children).', mimeType: 'application/json' },
    { uriTemplate: 'lws://linkset/{+path}', name: 'linkset', description: 'RFC 9264 linkset: anchor/up/type/describedby.', mimeType: 'application/linkset+json' },
    { uriTemplate: 'lws://meta/{+path}', name: 'meta', description: 'Resource metadata (size/modified).', mimeType: 'application/json' },
    { uriTemplate: 'lws://acl/{+path}', name: 'acl', description: 'Structured ACL (requires acl:Control).', mimeType: 'application/json' },
    { uriTemplate: 'lws://skill/{+path}', name: 'skill', description: 'A skill file body.', mimeType: 'application/json' },
  ];
}

export function listFixedResources() {
  return [
    { uri: 'lws://storage-description', name: 'storage-description', description: 'The LWS storage description (type:Storage + services).', mimeType: 'application/json' },
    { uri: 'lws://pod-info', name: 'pod-info', description: 'Pod identity + MCP capabilities.', mimeType: 'application/json' },
    { uri: 'lws://skills', name: 'skills', description: 'Skill index (WAC-filtered, no-oracle).', mimeType: 'application/json' },
  ];
}

// --- helpers ----------------------------------------------------------------

function jsonContents(uri, obj, mimeType = 'application/json') {
  return { contents: [{ uri, mimeType, text: JSON.stringify(obj, null, 2) }] };
}

// --- fixed resolvers --------------------------------------------------------

async function readPodInfo(ctx) {
  const skill = await readPodSkill().catch(() => null);
  const skillVisible = skill && (await wac(ctx, skill.path, AccessMode.READ));
  return jsonContents(fixedUri('pod-info'), {
    pod: ctx.origin,
    server: 'jss',
    protocolVersion: '2025-03-26',
    identity: ctx.webId || null,
    capabilities: { crud: true, acl: true, skills: true, resources: true },
    skill: skillVisible ? { path: skill.path, format: skill.format } : null,
  });
}

const FIXED = {
  'pod-info': readPodInfo,
  // 'storage-description' and 'skills' added in Task 5.
};

// --- templated resolvers (added in Tasks 4-5) -------------------------------

const KIND = {
  // 'resource','container','linkset','meta','acl' added in Task 4;
  // 'skill' added in Task 5.
};

// --- dispatch ---------------------------------------------------------------

export async function readResource(uri, ctx) {
  const parsed = parseUri(uri);
  if (!parsed) throw new ResourceError(RPC_ERRORS.INVALID_PARAMS, `unknown resource URI: ${uri}`);
  if (parsed.fixed) {
    const f = FIXED[parsed.fixed];
    if (!f) throw new ResourceError(RPC_ERRORS.INVALID_PARAMS, `unknown resource URI: ${uri}`);
    return f(ctx, uri);
  }
  const resolver = KIND[parsed.kind];
  if (!resolver) throw new ResourceError(RPC_ERRORS.INVALID_PARAMS, `unknown resource URI: ${uri}`);
  return resolver(parsed.path, ctx, uri);
}
