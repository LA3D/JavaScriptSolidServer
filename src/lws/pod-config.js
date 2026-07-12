// Spec §4b: the LWS service pointers (profileIndex, void) live in ONE pod
// resource named by --lws-config, read lazily and cached by mtime — not two
// per-service CLI flags. A fresh pod boots before the publish pipeline
// creates that resource, so absence is normal (services off, warn once);
// malformed content is loud but non-fatal (the pod keeps serving). Once the
// resource appears/changes, the next request picks it up — no restart.
export function makePodConfig(storage, storagePath) {
  const cache = { key: null, value: {} };
  let warned = false, errored = false;
  return {
    async get() {
      if (!storagePath) return {};
      const st = await storage.stat(storagePath);
      if (!st) {
        if (!warned) { console.warn(`--lws-config: ${storagePath} not present yet — LWS services off until it is published`); warned = true; }
        return {};
      }
      // mtime alone collides on coarse-granularity filesystems when two
      // writes land in the same tick; folding in size catches a same-mtime
      // content change of different length. Falls back to mtime alone if
      // `size` isn't reported.
      const key = st.size != null ? `${st.mtime.getTime()}:${st.size}` : `${st.mtime.getTime()}`;
      if (key !== cache.key) {
        try {
          const buf = await storage.read(storagePath);
          if (buf == null) throw new Error('read returned null');
          cache.value = JSON.parse(buf.toString());
          cache.key = key; errored = false;
        } catch (e) {
          if (!errored) { console.error(`--lws-config: ${storagePath} unreadable/malformed (${e.message}) — services off`); errored = true; }
          cache.value = {}; cache.key = key;
        }
      }
      return cache.value;
    },
  };
}
