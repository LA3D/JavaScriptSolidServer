// Spec §4b: the LWS service pointers (profileIndex, void) live in ONE pod
// resource named by --lws-config, read lazily and cached by mtime — not two
// per-service CLI flags. A fresh pod boots before the publish pipeline
// creates that resource, so absence is normal (services off, warn once);
// malformed content is loud but non-fatal (the pod keeps serving). Once the
// resource appears/changes, the next request picks it up — no restart.
export function makePodConfig(storage, storagePath) {
  const cache = { mtimeMs: -1, value: {} };
  let warned = false, errored = false;
  return {
    async get() {
      if (!storagePath) return {};
      const st = await storage.stat(storagePath);
      if (!st) {
        if (!warned) { console.warn(`--lws-config: ${storagePath} not present yet — LWS services off until it is published`); warned = true; }
        return {};
      }
      const mtimeMs = new Date(st.mtime).getTime();
      if (mtimeMs !== cache.mtimeMs) {
        try {
          const buf = await storage.read(storagePath);
          if (buf == null) throw new Error('read returned null');
          cache.value = JSON.parse(buf.toString());
          cache.mtimeMs = mtimeMs; errored = false;
        } catch (e) {
          if (!errored) { console.error(`--lws-config: ${storagePath} unreadable/malformed (${e.message}) — services off`); errored = true; }
          cache.value = {}; cache.mtimeMs = mtimeMs;
        }
      }
      return cache.value;
    },
  };
}
