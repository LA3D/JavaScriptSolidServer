// src/mcp/errors.js
// Structured error/teaching model for the MCP surface. A ResourceError becomes
// a JSON-RPC error on resources/read; admissionError/structuredError build the
// tool-side teaching content.
import { toolText } from './protocol.js';

export class ResourceError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'ResourceError';
    this.code = code;
    // §5: resource-read failures carry the SAME model-readable content[] shape
    // as tool errors, so a client renders both consistently instead of the
    // resource path exposing only a bare message (review #9).
    this.data = {
      content: [{ type: 'text', text: message }], isError: true,
      ...(data && typeof data === 'object' ? data : {}),
    };
  }
}

// Tool-side error whose CONTENT carries the readable text (the model reads
// content, not `data`). Reuses the toolText envelope; keeps structured `data`.
export function structuredError(text, data) {
  const r = { ...toolText(text), isError: true };
  if (data && typeof data === 'object') r.data = data;
  return r;
}

// The L3 teaching channel over MCP. Turns an applyLwsWrite reject into content
// the model can act on: the shape URI, each violation's sh:message +
// path/focusNode/value. This is what the v1 MCP path dropped (it sat in `data`).
export function admissionError(path, { violations = [], shapeUrl } = {}) {
  const lines = [`admission rejected: ${path} does not conform to its declared shape${shapeUrl ? ` <${shapeUrl}>` : ''}.`];
  for (const v of violations) {
    const bits = [v.message || 'constraint violation'];
    if (v.path) bits.push(`(path: ${v.path})`);
    if (v.focusNode) bits.push(`(focus: ${v.focusNode})`);
    if (v.value != null && v.value !== '') bits.push(`(value: ${v.value})`);
    lines.push('  - ' + bits.join(' '));
  }
  lines.push('Fix the resource to satisfy the shape, then retry.');
  return structuredError(lines.join('\n'), { violations, describedby: shapeUrl });
}
