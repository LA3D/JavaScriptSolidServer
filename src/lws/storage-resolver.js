// src/lws/storage-resolver.js
import { readDeclaredTypes, LWS_STORAGE } from './type-metadata.js';

// cache: candidate-root path -> boolean (is a storage root). Reset via clearStorageRootCache.
const _isRoot = new Map();

export function clearStorageRootCache() { _isRoot.clear(); }

async function isStorageRoot(storage, rootPath) {
  if (_isRoot.has(rootPath)) return _isRoot.get(rootPath);
  let marked = false;
  try { marked = (await readDeclaredTypes(storage, rootPath)).includes(LWS_STORAGE); } catch { marked = false; }
  _isRoot.set(rootPath, marked);
  return marked;
}

/**
 * The owning storage root path for a URL path, or null for server scope.
 * Fast path: first segment -> `/<seg>/` candidate, verified by the marker
 * (cached). null when the path is `/`, a `.well-known`, or a first segment
 * with no lws:Storage marker.
 * @param {{exists:Function, read:Function}} storage
 * @param {string} urlPath  URL pathname (== storage path in --lws path mode)
 */
export async function storageRootFor(storage, urlPath) {
  if (!urlPath || urlPath === '/') return null;
  const segs = urlPath.split('/').filter(Boolean);
  if (!segs.length) return null;
  if (segs[0] === '.well-known') return null;
  const candidate = `/${segs[0]}/`;
  return (await isStorageRoot(storage, candidate)) ? candidate : null;
}
