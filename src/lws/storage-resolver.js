// src/lws/storage-resolver.js
import { readDeclaredTypes, LWS_STORAGE } from './type-metadata.js';

// cache: candidate-root path -> true, POSITIVE RESULTS ONLY (storage-root status is monotonic:
// unmarked -> marked exactly once at provisioning, never unmarked). A miss is never cached, so a
// pod provisioned after an earlier miss still resolves on the next check. Reset via clearStorageRootCache.
const _isRoot = new Map();

export function clearStorageRootCache() { _isRoot.clear(); }

async function isStorageRoot(storage, rootPath) {
  if (_isRoot.get(rootPath)) return true;        // only positives are cached
  let marked = false;
  try { marked = (await readDeclaredTypes(storage, rootPath)).includes(LWS_STORAGE); } catch { marked = false; }
  if (marked) _isRoot.set(rootPath, true);       // cache only the positive; a miss re-checks next time
  return marked;
}

/**
 * The owning storage root path for a URL path, or null for server scope.
 * Fast path: first segment -> `/<seg>/` candidate, verified by the marker
 * (cached). Falls back to the root-pod `/` marker (R6) when no named-pod
 * candidate matched. null for a `.well-known` path, or when neither the named
 * candidate nor `/` carries the lws:Storage marker.
 * @param {{exists:Function, read:Function}} storage
 * @param {string} urlPath  URL pathname (== storage path in --lws path mode)
 */
export async function storageRootFor(storage, urlPath) {
  if (!urlPath) return null;
  const segs = urlPath.split('/').filter(Boolean);
  if (segs[0] === '.well-known') return null;
  if (segs.length) {
    const candidate = `/${segs[0]}/`;
    if (await isStorageRoot(storage, candidate)) return candidate;
  }
  // Root-pod fallback (R6): a single-user deployment marks `/` itself
  // (createRootPodStructure). Without this, root-pod resources point their
  // storageDescription at the empty ServerIndex and referent 303s never arm.
  // Named-pod deployments never mark `/`, so this stays null for them.
  return (await isStorageRoot(storage, '/')) ? '/' : null;
}
