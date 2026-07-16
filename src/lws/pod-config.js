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
      // `size` isn't reported. Tolerates either a Date `mtime` (real
      // storage backends) or a raw `mtimeMs` number (lightweight storage
      // stubs, e.g. in tests) — same cache-freshness contract either way.
      const mtimeKey = st.mtime instanceof Date ? st.mtime.getTime() : (st.mtimeMs ?? 0);
      const key = st.size != null ? `${mtimeKey}:${st.size}` : `${mtimeKey}`;
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

// Multi-tenant round: one pod-config resource PER STORAGE ROOT rather than
// one server-wide file — `relConfigPath` is the `--lws-config` value
// re-interpreted as relative under each storage root (e.g.
// `profiles/pod-config.jsonld`), so `/alice/` and `/bob/` each get their own
// {profileIndex, void, uriSpaces} without cross-tenant leakage. One
// makePodConfig reader is cached per root (first access wins, same
// mtime+size cache as above thereafter). `storageRootPath` is what
// storageRootFor() (src/lws/storage-resolver.js) resolves; a falsy root
// (server scope, or --lws off) is server-neutral: always empty config.
export function makePodConfigResolver(storage, relConfigPath) {
  const byRoot = new Map();
  const empty = { get: async () => ({}) };
  return {
    for(storageRootPath) {
      if (!storageRootPath) return empty;
      if (!byRoot.has(storageRootPath)) {
        const abs = storageRootPath + relConfigPath.replace(/^\//, '');
        byRoot.set(storageRootPath, makePodConfig(storage, abs));
      }
      return byRoot.get(storageRootPath);
    },
  };
}
