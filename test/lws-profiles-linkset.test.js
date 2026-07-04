import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLinkset } from '../src/lws/linkset.js';
import { metaTargets, conformsToTargets, describedbyTargets } from '../src/lws/constraint.js';

const DCT_CONFORMS = 'http://purl.org/dc/terms/conformsTo';

function memStorage(files) {
  return {
    exists: async (p) => p in files,
    read: async (p) => { if (!(p in files)) throw new Error('ENOENT'); return Buffer.from(files[p]); },
  };
}

test('conformsToTargets reads dct:conformsTo from .meta; describedbyTargets still works via metaTargets', async () => {
  const meta = JSON.stringify({
    '@context': { dct: 'http://purl.org/dc/terms/', powder: 'http://www.w3.org/2007/05/powder-s#' },
    '@id': '',
    'dct:conformsTo': { '@id': 'https://pod.example/profiles/llm-wiki/profile.jsonld' },
    'powder:describedby': { '@id': 'https://pod.example/profiles/llm-wiki/shapes.ttl' },
  });
  const s = memStorage({ 'alice/concepts/.meta': meta });
  assert.deepEqual(await conformsToTargets(s, 'alice/concepts/.meta', 'https://pod.example/alice/concepts/'),
    ['https://pod.example/profiles/llm-wiki/profile.jsonld']);
  assert.deepEqual(await describedbyTargets(s, 'alice/concepts/.meta', 'https://pod.example/alice/concepts/'),
    ['https://pod.example/profiles/llm-wiki/shapes.ttl']);
  assert.deepEqual(await metaTargets(s, 'missing/.meta', 'https://x/', DCT_CONFORMS), []);
});

test('generateLinkset emits the full-URI conformsTo member only when declared', () => {
  const withIt = generateLinkset('https://pod.example/alice/concepts/', {
    isContainer: true, conformsTo: ['https://pod.example/profiles/llm-wiki/profile.jsonld'] });
  assert.deepEqual(withIt.linkset[0][DCT_CONFORMS], [{ href: 'https://pod.example/profiles/llm-wiki/profile.jsonld' }]);
  const without = generateLinkset('https://pod.example/alice/x.md', { isContainer: false });
  assert.equal(DCT_CONFORMS in without.linkset[0], false);   // negative: undeclared -> absent
});
