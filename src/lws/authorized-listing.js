// src/lws/authorized-listing.js
// WAC-filter a container's directory entries for the requesting agent — the
// same per-resource checkAccess()-and-drop discipline as authorized-
// resources.js (the filter IS the authz boundary; members are HIDDEN, never
// 401'd — no discovery oracle). Closes the /types/*-vs-listing asymmetry
// (probe #3: anonymous listings advertised members that then 401'd).
import { checkAccess } from '../wac/checker.js';
import { AccessMode } from '../wac/parser.js';

export async function filterReadableEntries({ entries, containerUrl, containerStoragePath, agentWebId }) {
  const baseUrl = containerUrl.endsWith('/') ? containerUrl : containerUrl + '/';
  const basePath = containerStoragePath.endsWith('/') ? containerStoragePath : containerStoragePath + '/';
  const aclCache = new Map();
  const out = [];
  for (const e of entries) {
    // .acl sidecars are Control-gated on the resource they PROTECT, not
    // Read-gated on the sidecar's own path (src/auth/middleware.js
    // authorizeAclAccess, called for every direct .acl GET) — check the
    // same way here, else the sidecar's bare presence in the listing is
    // itself the existence oracle this filter exists to close.
    let allowed;
    if (e.name === '.acl') {
      // Bare `.acl` protects the container it lives in.
      ({ allowed } = await checkAccess({
        resourceUrl: baseUrl, resourcePath: basePath, isContainer: true,
        agentWebId, requiredMode: AccessMode.CONTROL, aclCache,
      }));
    } else if (e.name.endsWith('.acl')) {
      // `name.acl` protects the sibling file `name`.
      const protectedName = e.name.slice(0, -'.acl'.length);
      ({ allowed } = await checkAccess({
        resourceUrl: baseUrl + protectedName, resourcePath: basePath + protectedName,
        isContainer: false, agentWebId, requiredMode: AccessMode.CONTROL, aclCache,
      }));
    } else {
      const suffix = e.isDirectory ? '/' : '';
      ({ allowed } = await checkAccess({
        resourceUrl: baseUrl + e.name + suffix,
        resourcePath: basePath + e.name + suffix,
        isContainer: e.isDirectory,
        agentWebId, requiredMode: AccessMode.READ, aclCache,
      }));
    }
    if (allowed) out.push(e);
  }
  return out;
}
