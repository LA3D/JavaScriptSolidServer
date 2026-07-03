// src/mcp/read.js
// One bounded-read helper for the MCP surface. Reads at most MAX_BODY_BYTES via
// a byte-range stream (never loads a multi-hundred-MB object fully into memory
// just to slice it — review #6) and reports whether the body was truncated so
// the model isn't handed a partial document as if it were whole (review #5).
// Both lws://resource and the describe_resource tool go through here so they
// can't drift on the limit or the signal (review #12).
import * as storage from '../storage/filesystem.js';

export const MAX_BODY_BYTES = 200_000;

// → { text, truncated, bytes } | null (null = not found). `bytes` is the full
// resource size; `text` is the first MAX_BODY_BYTES decoded as UTF-8.
export async function readBounded(path, max = MAX_BODY_BYTES) {
  const s = await storage.stat(path);
  if (!s || s.isDirectory) return null;
  const bytes = s.size;
  const truncated = bytes > max;
  const handle = storage.createReadStream(path, { start: 0, end: Math.min(bytes, max) - 1 });
  if (!handle) return null;
  const chunks = [];
  for await (const chunk of handle.stream) chunks.push(chunk);
  return { text: Buffer.concat(chunks).toString('utf8'), truncated, bytes };
}
