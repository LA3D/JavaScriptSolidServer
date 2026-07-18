// src/handlers/type-index.js
import { buildTypeIndex, parseFilter, matchesFilter, containerItemTypes, FilterError } from '../lws/type-index.js';
import { getWebIdFromRequestAsync } from '../auth/token.js';
import { buildResourceUrl } from '../auth/middleware.js';
import { collectAuthorizedResources } from '../lws/authorized-resources.js';
import { sendJsonWithEtag } from '../utils/conditional.js';

const LWS_JSON = 'application/lws+json';

// GET /types/index is a virtual aggregate endpoint (no backing resource),
// so — same as /mcp, /db, /.terminal, /tunnel — it's exempt from the
// blanket per-resource WAC preHandler in server.js and resolves identity
// itself here. The per-resource checkAccess() calls below (inside
// collectAuthorizedResources) ARE the authorization: dropping denials is
// what keeps this endpoint safe to expose without a resource-level ACL of
// its own.
export async function handleTypeIndex(request, reply, { scopeRoot = '/' } = {}) {
  const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
  const resources = await collectAuthorizedResources({ agentWebId, scopeRoot,
    buildId: (urlPath) => buildResourceUrl(request, urlPath) });
  reply.header('Cache-Control', 'private, no-store');
  reply.type(LWS_JSON);
  // R3/R5: GET-only route (no POST /types/index) — always the ETag arm.
  return sendJsonWithEtag(request, reply, buildTypeIndex(resources.map((r) => r.types)));
}

const LWS_CONTEXT = 'https://www.w3.org/ns/lws/v1';

// Returns per-resource {id, types} so TypeSearch can filter by CNF and
// describe the surviving resources. Same authorization story as
// handleTypeIndex above: /types/search is a virtual aggregate endpoint
// exempted from the blanket preHandler, so the per-resource
// checkAccess()-and-drop loop inside collectAuthorizedResources IS the authz.
// Indexed-relation targets (describedby, conformsTo) are resolved per-resource
// only for the relations the filter actually references, to avoid an extra
// .meta read on every resource.
async function authorizedResources(request, { neededRelations = [], scopeRoot = '/' } = {}) {
  const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
  return collectAuthorizedResources({
    agentWebId, neededRelations, scopeRoot,
    buildId: (urlPath) => buildResourceUrl(request, urlPath),
  });
}

// LWS TypeSearchService — GET/POST /types/search. `type` is the only
// filter parameter in v1 (CNF: comma = OR within a group, repeated
// param/array element = AND across groups). GET reads ?type=..., POST
// requires application/lws+json and the array-of-arrays body shape;
// any other content type is 415. A malformed filter (non-absolute URI,
// wrong body shape) is a 400 — a well-formed filter matching nothing is
// just an empty ContainerPage, not an error.
export async function handleTypeSearch(request, reply, { scopeRoot = '/' } = {}) {
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

  const neededRelations = Object.keys(filter.relations);
  const resources = await authorizedResources(request, { neededRelations, scopeRoot });
  const matched = resources.filter((r) => matchesFilter(r, filter));
  reply.header('Cache-Control', 'private, no-store');
  reply.type(LWS_JSON);
  const body = {
    '@context': LWS_CONTEXT, type: 'ContainerPage', totalItems: matched.length,
    items: matched.map((r) => ({ id: r.id, type: containerItemTypes(r.types) })),
  };
  // R3/R5: GET gets the ETag treatment; POST (this route also handles
  // POST /types/search) is left completely untouched — same body shape,
  // same reply.send(JSON.stringify(..., null, 2)) as before.
  if (request.method === 'GET') return sendJsonWithEtag(request, reply, body);
  return reply.send(JSON.stringify(body, null, 2));
}
