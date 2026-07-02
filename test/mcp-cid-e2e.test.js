import { test } from 'node:test';

// Forcing function: CID-over-MCP *accept* needs a public-IP host (JSS's SSRF
// guard blocks fetching a CID doc on a loopback/private IP). Un-skip on the
// public rung. See docs/foundations/05-jss-spec-conformance.md axis 6.
test('@public-rung: audience-bound /mcp ACCEPTS a valid LWS-CID token', { skip: 'needs public-IP rung' }, () => {});
