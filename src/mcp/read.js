// src/mcp/read.js
// One bounded-read helper for the MCP surface. Reads at most MAX_BODY_BYTES via
// a byte-range stream (never loads a multi-hundred-MB object fully into memory
// just to slice it — review #6) and reports whether the body was truncated so
// the model isn't handed a partial document as if it were whole (review #5).
// Both the resources/read body view and the describe_resource tool go through
// here so they can't drift on the limit or the signal (review #12).
//
// It's also the single choke point for the TRUST decision (task dt5): the
// pod's own RDF/JSON-LD is affordance — preserve structure + @context, strip
// only leaf values; opaque/free-text is untrusted — envelope it. Every read
// surface (resources/read, read_resource, describe_resource) calls
// sanitizeForTrust on the SAME bounded-read result so they can't drift on
// which resources get fenced.
import * as storage from '../storage/filesystem.js';
import { getContentType, isRdfContentType } from '../utils/url.js';
import { sanitizeBody, sanitizeJsonLeaves } from './sanitize.js';
import { withInlineContext } from '../lws/context.js';

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

// Recognize JSON by content for a truly unknown (extensionless -> octet-stream)
// type too, so an agent's JSON-LD written at a path without a `.jsonld`
// extension keeps its @context instead of being enveloped. An EXPLICIT
// text/* type is left as the writer declared it (still enveloped).
// → { mimeType, text } — the exact body a read surface should hand the model.
export function sanitizeForTrust(path, r) {
  const type = getContentType(path);
  const unknown = type === 'application/octet-stream';
  if ((isRdfContentType(type) || (unknown && /^\s*[{[]/.test(r.text))) && !r.truncated) {
    try {
      const obj = JSON.parse(r.text);
      const safe = withInlineContext(sanitizeJsonLeaves(obj));   // field-level strip, structure kept
      // Keep a declared RDF type; else infer ld+json when an @context is present.
      const mimeType = isRdfContentType(type) ? type
        : (obj && typeof obj === 'object' && obj['@context']) ? 'application/ld+json' : 'application/json';
      return { mimeType, text: JSON.stringify(safe, null, 2) };
    } catch { /* not JSON (e.g. Turtle) or malformed — fall through to envelope */ }
  }
  let label = `untrusted pod content — original type ${type}`;
  if (r.truncated) label += ` (truncated: first ${MAX_BODY_BYTES} of ${r.bytes} bytes)`;
  return { mimeType: 'text/plain', text: sanitizeBody(r.text, label) };
}
