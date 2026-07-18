// src/lws/storage-index.js
// Multi-tenant storage round, Task A5: enumerate the pod's top-level
// storage roots for the ServerIndex well-known. Two independent gates, same
// discipline as authorized-listing.js's WAC-filtered container listings:
// (1) marker-gated — storageRootFor (A2) so an ordinary top-level container
// that isn't a provisioned pod never shows up; (2) WAC-filtered — a storage
// the requester can't even READ is never advertised (that would leak
// pod-name existence as an oracle, the same class of bug S1/probe#3 closed
// for regular container listings). Reuses filterReadableEntries rather than
// hand-rolling ACL checks — one WAC-filter implementation for every listing
// surface in the server.
import { storageRootFor } from './storage-resolver.js';
import { filterReadableEntries } from './authorized-listing.js';
import { checkAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';

/**
 * The storage roots (e.g. `['/alice/']`) visible to the requester: every
 * top-level `/` directory entry carrying the lws:Storage marker AND on
 * which the requester has READ access (checked on the root container
 * itself, mirroring a normal container-listing entry check).
 *
 * Takes `{ origin, webId }` rather than a fastify `request` (Task A7): the
 * MCP surface has no fastify request to resolve identity from — its webId
 * is already resolved onto `ctx.webId` by the /mcp route — so this stays a
 * plain-data signature both the HTTP well-known route (server.js, which
 * resolves webId itself via getWebIdFromRequestAsync) and MCP's
 * resources.js (which already has ctx.webId) can call identically. One
 * roster implementation, two surfaces agreeing.
 * @param {{listContainer:Function}} storage
 * @param {{origin:string, webId:string|null}} requester
 * @returns {Promise<string[]>}
 */
export async function listVisibleStorageRoots(storage, { origin, webId }) {
  const entries = await storage.listContainer('/');
  const dirs = (entries || []).filter((e) => e.isDirectory);
  const marked = [];
  for (const e of dirs) {
    if (await storageRootFor(storage, `/${e.name}/`)) marked.push(e);
  }
  const roots = [];
  // Root-pod (R6): `/` itself may carry the lws:Storage marker (single-user root
  // deploy). The named-root scan above never sees `/`, so add it here — WAC-
  // filtered on READ of `/` itself, the same discipline every named root gets —
  // so root-pod discovery (Link -> ServerIndex -> this roster) resolves instead
  // of landing on an empty index. Named-pod deployments never mark `/`, so
  // `storageRootFor(storage, '/')` is null for them and the roster is unchanged.
  if (await storageRootFor(storage, '/')) {
    const { allowed } = await checkAccess({
      resourceUrl: `${origin}/`, resourcePath: '/', isContainer: true,
      agentWebId: webId ?? null, requiredMode: AccessMode.READ,
    });
    if (allowed) roots.push('/');
  }
  if (marked.length) {
    const readable = await filterReadableEntries({
      entries: marked, containerUrl: `${origin}/`, containerStoragePath: '/', agentWebId: webId ?? null,
    });
    roots.push(...readable.map((e) => `/${e.name}/`));
  }
  return roots;
}
