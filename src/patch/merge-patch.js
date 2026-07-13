// RFC 7386 JSON Merge Patch (P1 — LWS update-resource MUST: "MUST minimally
// support JSON Merge Patch"). `null` deletes a key; nested objects merge
// recursively; anything else (array, scalar) replaces wholesale.
export function applyMergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = (target && typeof target === 'object' && !Array.isArray(target)) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = applyMergePatch(out[k], v);
  }
  return out;
}
