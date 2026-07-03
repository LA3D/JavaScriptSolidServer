import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withInlineContext, LWS_CONTEXT_OBJECT } from '../src/lws/context.js';

test('withInlineContext replaces the 404-ing @context URL with the inline object', () => {
  const out = withInlineContext({ '@context': 'https://www.w3.org/ns/lws/v1', id: 'x' });
  assert.equal(typeof out['@context'], 'object');
  assert.equal(out['@context']['items'], 'lws:items');
  // a non-lws @context (object or array) is left untouched
  const passthrough = { '@context': { ex: 'http://ex/' } };
  assert.deepEqual(withInlineContext(passthrough), passthrough);
});
