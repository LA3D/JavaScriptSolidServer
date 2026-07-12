import { admit, urlToStoragePath } from './admission.js';
import { captureDeclaredTypes, typeStorePath } from './type-metadata.js';
import { writeTypeConsistency } from './write-consistency.js';

/**
 * Shared LWS write pipeline: name/type gate → SHACL admission → storage.write
 * → type-capture. Request-agnostic so both the HTTP handlers and the MCP
 * write tools use ONE enforcement path (the drift that let MCP bypass both
 * the gate and admission becomes impossible — review #2/#10).
 * Callers own their own reply/tool framing; this returns data only.
 */
export async function applyLwsWrite({
  storage, storagePath, resourceUrl, content, contentType, declaredTypes = [], lwsEnabled,
}) {
  // #2 (review 2026-07-12): the gate runs at THE choke point every write
  // surface shares (HTTP PUT/POST + all MCP write tools) — no surface can
  // store a name/type lie or an admission-skipped body at an RDF name.
  const c = writeTypeConsistency({ urlPath: storagePath, submittedType: contentType, lwsEnabled });
  if (!c.ok) return { ok: false, problem: { ...c.problem, instance: resourceUrl } };

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
