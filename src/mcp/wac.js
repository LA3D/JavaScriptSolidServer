// Shared WAC + path helpers for the MCP surface. Both the tool registry
// (tools.js) and the resource registry (resources.js) import these so a
// resource read and a tool call have identical access semantics.
import * as storage from '../storage/filesystem.js';
import { checkAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';
import { getParentContainer, canonicalPodPath } from '../utils/url.js';

export function buildUrl(ctx, path) {
  if (!path.startsWith('/')) path = '/' + path;
  return `${ctx.origin}${path}`;
}

// Parent container of a pod path. Reuses the shared util so the MCP linkset
// `up` link and WAC parent-fallback stay identical to the HTTP layer (#12).
export function parentPath(p) {
  if (p === '/' || p === '') return '/';
  return getParentContainer(p);
}

/**
 * THE path boundary. Resolve a client-supplied MCP path to the single canonical
 * form that both the authorization check and the storage call must use.
 *
 * Two steps. `canonicalPodPath` (src/utils/url.js) collapses `%2F`/`%2E`,
 * `..`, `//`, `.` and friends in URL space — the same node `urlToPath` lands
 * on. Then container-ness is resolved against STORAGE rather than trusted from
 * the string: a trailing slash on a path that is actually a FILE is the attack
 * (`/inbox/victim%2F` decodes to `/inbox/victim/`, which findApplicableAcl
 * would treat as a container and satisfy from the parent default, never
 * reading `/inbox/victim.acl`), so the marker is dropped when storage says the
 * node exists and is not a directory. The same stat-derived container decision
 * `readAclView` already makes (src/mcp/resources.js, review #3).
 *
 * A trailing slash on a NON-EXISTENT path is left alone: both forms fall back
 * to the parent container below, so the decision is identical and this stays a
 * strictly-narrowing change. A path with no trailing slash is never PROMOTED to
 * a container — that direction is not the vulnerable one and promoting would
 * change long-standing semantics for callers not audited here.
 *
 * This lives in wac() rather than only at each tool so that callers which do
 * not exist yet inherit the invariant. Tools additionally normalize at their
 * own entry (src/mcp/tools.js) so the OPERATION uses the same path the guard
 * approved — a tool that forgets is denied correctly, but should also act
 * correctly.
 * @param {string} p
 * @returns {Promise<string>}
 */
export async function resolvePath(p) {
  const c = canonicalPodPath(p);
  if (c === '/' || !c.endsWith('/')) return c;
  const s = await storage.stat(c);
  return (s && !s.isDirectory) ? c.replace(/\/+$/, '') : c;
}

export async function wac(ctx, path, mode) {
  // Normalize BEFORE deciding anything — the guard and the operation must
  // never disagree about which path is in play (Task 7a round 3).
  path = await resolvePath(path);
  // For writes against a non-existent resource, fall back to checking the
  // parent container — same pattern as src/auth/middleware.js so MCP tools
  // and resources have identical WAC semantics to the HTTP endpoints.
  const isWrite = mode === AccessMode.WRITE || mode === AccessMode.APPEND;
  let checkPath = path;
  let checkIsContainer = path.endsWith('/');
  if (isWrite && !path.endsWith('/') && !(await storage.exists(path))) {
    checkPath = parentPath(path);
    checkIsContainer = true;
  }
  const { allowed } = await checkAccess({
    resourceUrl: buildUrl(ctx, checkPath),
    resourcePath: checkPath,
    isContainer: checkIsContainer,
    agentWebId: ctx.webId,
    requiredMode: mode,
  });
  return allowed;
}
