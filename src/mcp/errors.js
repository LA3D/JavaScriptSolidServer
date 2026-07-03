// src/mcp/errors.js
// Structured error/teaching model for the MCP surface. The full teaching
// builder (admissionError) lands in Task 7; Task 3 only needs ResourceError,
// which the transport converts into a JSON-RPC error on resources/read.

export class ResourceError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'ResourceError';
    this.code = code;
    this.data = data;
  }
}

// Tool-side error whose CONTENT carries the readable text (the model reads
// content, not `data`). Keeps structured `data` too for programmatic use.
export function structuredError(text, data) {
  const r = { content: [{ type: 'text', text }], isError: true };
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
