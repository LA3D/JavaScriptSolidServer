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
