// src/handlers/type-index.js
import * as storage from '../storage/filesystem.js';
import { walkResources } from '../storage/filesystem.js';
import { readDeclaredTypes } from '../lws/type-metadata.js';
import { resourceTypes, buildTypeIndex } from '../lws/type-index.js';
import { checkAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';
import { getWebIdFromRequestAsync } from '../auth/token.js';

const LWS_JSON = 'application/lws+json';

// GET /types/index is a virtual aggregate endpoint (no backing resource),
// so — same as /mcp, /db, /.terminal, /tunnel — it's exempt from the
// blanket per-resource WAC preHandler in server.js and resolves identity
// itself here. The per-resource checkAccess() calls below ARE the
// authorization: dropping denials is what keeps this endpoint safe to
// expose without a resource-level ACL of its own.
async function authorizedTypeLists(request) {
  const origin = `${request.protocol}://${request.hostname}`;
  const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
  const aclCache = new Map();
  const resources = await walkResources('/');
  const lists = [];
  for (const r of resources) {
    const { allowed } = await checkAccess({
      resourceUrl: origin + r.urlPath, resourcePath: r.urlPath,
      isContainer: r.isDirectory, agentWebId, requiredMode: AccessMode.READ, aclCache,
    });
    if (!allowed) continue;
    const declared = await readDeclaredTypes(storage, r.urlPath);
    lists.push(resourceTypes({ isDirectory: r.isDirectory, declared }));
  }
  return lists;
}

export async function handleTypeIndex(request, reply) {
  const lists = await authorizedTypeLists(request);
  reply.header('Cache-Control', 'private, no-store');
  reply.type(LWS_JSON);
  return reply.send(JSON.stringify(buildTypeIndex(lists), null, 2));
}
