// src/handlers/type-index.js
import * as storage from '../storage/filesystem.js';
import { walkResources } from '../storage/filesystem.js';
import { readDeclaredTypes } from '../lws/type-metadata.js';
import { resourceTypes, buildTypeIndex, parseFilter, matchesFilter, containerItemTypes, FilterError } from '../lws/type-index.js';
import { describedbyTargets } from '../lws/constraint.js';
import { checkAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';
import { getWebIdFromRequestAsync } from '../auth/token.js';
import { buildResourceUrl } from '../auth/middleware.js';

const LWS_JSON = 'application/lws+json';

// GET /types/index is a virtual aggregate endpoint (no backing resource),
// so — same as /mcp, /db, /.terminal, /tunnel — it's exempt from the
// blanket per-resource WAC preHandler in server.js and resolves identity
// itself here. The per-resource checkAccess() calls below ARE the
// authorization: dropping denials is what keeps this endpoint safe to
// expose without a resource-level ACL of its own.
async function authorizedTypeLists(request) {
  const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
  const aclCache = new Map();
  const resources = await walkResources('/');
  const lists = [];
  for (const r of resources) {
    const { allowed } = await checkAccess({
      resourceUrl: buildResourceUrl(request, r.urlPath), resourcePath: r.urlPath,
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

const LWS_CONTEXT = 'https://www.w3.org/ns/lws/v1';

// Like authorizedTypeLists but returns per-resource {id, types} so
// TypeSearch can filter by CNF and describe the surviving resources.
// Same authorization story as authorizedTypeLists above: /types/search
// is a virtual aggregate endpoint exempted from the blanket preHandler,
// so the per-resource checkAccess()-and-drop loop here IS the authz.
// describedby targets are resolved per-resource only when the filter
// references them, to avoid an extra .meta read on every resource.
async function authorizedResources(request, { needDescribedby = false } = {}) {
  const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
  const aclCache = new Map();
  const resources = await walkResources('/');
  const out = [];
  for (const r of resources) {
    const id = buildResourceUrl(request, r.urlPath);
    const { allowed } = await checkAccess({
      resourceUrl: id, resourcePath: r.urlPath,
      isContainer: r.isDirectory, agentWebId, requiredMode: AccessMode.READ, aclCache,
    });
    if (!allowed) continue;
    const declared = await readDeclaredTypes(storage, r.urlPath);
    const entry = { id, types: resourceTypes({ isDirectory: r.isDirectory, declared }) };
    if (needDescribedby) {
      entry.relations = { describedby: await describedbyTargets(storage, r.urlPath + '.meta', id) };
    }
    out.push(entry);
  }
  return out;
}

// LWS TypeSearchService — GET/POST /types/search. `type` is the only
// filter parameter in v1 (CNF: comma = OR within a group, repeated
// param/array element = AND across groups). GET reads ?type=..., POST
// requires application/lws+json and the array-of-arrays body shape;
// any other content type is 415. A malformed filter (non-absolute URI,
// wrong body shape) is a 400 — a well-formed filter matching nothing is
// just an empty ContainerPage, not an error.
export async function handleTypeSearch(request, reply) {
  let filter;
  try {
    if (request.method === 'POST') {
      const ct = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== LWS_JSON) {
        return reply.code(415).type('application/problem+json')
          .send({ type: 'about:blank', status: 415, title: 'Unsupported Media Type' });
      }
      let body;
      if (Buffer.isBuffer(request.body)) body = JSON.parse(request.body.toString('utf8') || '{}');
      else if (typeof request.body === 'string') body = JSON.parse(request.body || '{}');
      else if (request.body && typeof request.body === 'object') body = request.body;
      else body = {};
      filter = parseFilter({ body });
    } else {
      const q = new URLSearchParams(request.url.split('?')[1] || '');
      filter = parseFilter({ query: q });
    }
  } catch (e) {
    const status = e instanceof FilterError ? e.status : 400;
    return reply.code(status).type('application/problem+json')
      .send({ type: 'about:blank', status, title: 'Bad Request', detail: e.message });
  }

  const needDescribedby = Object.keys(filter.relations).length > 0;
  const resources = await authorizedResources(request, { needDescribedby });
  const matched = resources.filter((r) => matchesFilter(r, filter));
  reply.header('Cache-Control', 'private, no-store');
  reply.type(LWS_JSON);
  return reply.send(JSON.stringify({
    '@context': LWS_CONTEXT, type: 'ContainerPage', totalItems: matched.length,
    items: matched.map((r) => ({ id: r.id, type: containerItemTypes(r.types) })),
  }, null, 2));
}
