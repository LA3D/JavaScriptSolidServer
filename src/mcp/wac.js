// Shared WAC + path helpers for the MCP surface. Both the tool registry
// (tools.js) and the resource registry (resources.js) import these so a
// resource read and a tool call have identical access semantics.
import * as storage from '../storage/filesystem.js';
import { checkAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';

export function buildUrl(ctx, path) {
  if (!path.startsWith('/')) path = '/' + path;
  return `${ctx.origin}${path}`;
}

export function parentPath(p) {
  if (p === '/' || p === '') return '/';
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx + 1);
}

export async function wac(ctx, path, mode) {
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
