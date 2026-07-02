import { admit, urlToStoragePath } from './admission.js';
import { captureDeclaredTypes, typeStorePath } from './type-metadata.js';

/**
 * Shared LWS write pipeline: SHACL admission → storage.write → type-capture.
 * Request-agnostic so both the HTTP handlers and the MCP write tools use ONE
 * enforcement path (the drift that let MCP bypass admission becomes impossible).
 * Callers own their own reply/tool framing; this returns data only.
 */
export async function applyLwsWrite({
  storage, storagePath, resourceUrl, content, contentType, declaredTypes = [], lwsEnabled,
}) {
  let shapeUrl = null;
  let advisories = [];

  if (lwsEnabled) {
    const targetMetaPath = storagePath + '.meta';
    const containerMetaPath = storagePath.slice(0, storagePath.lastIndexOf('/') + 1) + '.meta';
    const result = await admit({
      storage, content, contentType, resourceUrl,
      targetMetaPath, containerMetaPath, shapeUrlToPath: urlToStoragePath,
    });
    if (result.decision === 'reject') {
      return { ok: false, shapeUrl: result.shapeUrl, violations: result.violations };
    }
    shapeUrl = result.shapeUrl || null;
    advisories = result.advisories || [];
  }

  const wrote = await storage.write(storagePath, content);

  if (lwsEnabled && wrote) {
    if (declaredTypes.length) await captureDeclaredTypes(storage, storagePath, declaredTypes);
    else await storage.remove(typeStorePath(storagePath));
  }

  return { ok: true, wrote, shapeUrl, advisories };
}
