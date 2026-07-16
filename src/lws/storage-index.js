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
import { getWebIdFromRequestAsync } from '../auth/token.js';
import { storageRootFor } from './storage-resolver.js';
import { filterReadableEntries } from './authorized-listing.js';

/**
 * The storage roots (e.g. `['/alice/']`) visible to the requester: every
 * top-level `/` directory entry carrying the lws:Storage marker AND on
 * which the requester has READ access (checked on the root container
 * itself, mirroring a normal container-listing entry check).
 * @param {{listContainer:Function}} storage
 * @param {import('fastify').FastifyRequest} request
 * @returns {Promise<string[]>}
 */
export async function listVisibleStorageRoots(storage, request) {
  const entries = await storage.listContainer('/');
  const dirs = (entries || []).filter((e) => e.isDirectory);
  const marked = [];
  for (const e of dirs) {
    if (await storageRootFor(storage, `/${e.name}/`)) marked.push(e);
  }
  if (!marked.length) return [];
  const { webId: agentWebId } = await getWebIdFromRequestAsync(request).catch(() => ({ webId: null }));
  const origin = `${request.protocol}://${request.hostname}`;
  const readable = await filterReadableEntries({
    entries: marked, containerUrl: `${origin}/`, containerStoragePath: '/', agentWebId,
  });
  return readable.map((e) => `/${e.name}/`);
}
