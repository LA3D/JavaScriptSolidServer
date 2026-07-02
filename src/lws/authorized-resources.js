// src/lws/authorized-resources.js
import { walkResources } from '../storage/filesystem.js';
import * as storage from '../storage/filesystem.js';
import { checkAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';
import { resourceTypes } from './type-index.js';
import { readDeclaredTypes } from './type-metadata.js';
import { describedbyTargets } from './constraint.js';

/** Origin-based resource id (path-mode: id = origin + urlPath). */
function idFor(origin, urlPath) { return origin.replace(/\/$/, '') + urlPath; }

/**
 * The single WAC-filtered walk. The per-resource checkAccess()-and-drop loop
 * IS the authz boundary — the filter is the GET predicate, so there is no
 * discovery oracle. Reused by the HTTP /types/* handlers and the MCP read
 * tools (identity keyed on `agentWebId` instead of a Fastify request).
 */
// `buildId` lets a caller override how a walked urlPath becomes the resource
// id — the HTTP handler needs subdomain-mode-aware `buildResourceUrl`
// (path-mode `origin + urlPath` differs from it when subdomains are on), so
// it passes its own; MCP tools have no subdomain concern and use the default.
export async function collectAuthorizedResources({ agentWebId, origin, needDescribedby = false, buildId } = {}) {
  const idOf = buildId || ((urlPath) => idFor(origin, urlPath));
  const aclCache = new Map();
  const resources = await walkResources('/');
  const out = [];
  for (const r of resources) {
    const id = idOf(r.urlPath);
    const { allowed } = await checkAccess({
      resourceUrl: id, resourcePath: r.urlPath, isContainer: r.isDirectory,
      agentWebId, requiredMode: AccessMode.READ, aclCache,
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
