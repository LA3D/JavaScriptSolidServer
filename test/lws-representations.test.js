import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRepresentations } from '../src/lws/representations.js';

const ALTR = 'http://www.w3.org/ns/dx/connegp/altr#';
const DCT = 'http://purl.org/dc/terms/';

// minimal in-memory storage stub matching constraint.js usage
function stubStorage(metaJson) {
  return {
    async exists() { return metaJson != null; },
    async read() { return Buffer.from(JSON.stringify(metaJson), 'utf8'); },
  };
}

const RES = 'https://pod.example/alice/mem-a';
const LINKS = 'https://pod.example/alice/mem-a.links.jsonld';
const CONTENT_P = 'https://profiles.example/content';
const LINKS_P = 'https://profiles.example/links';

test('readRepresentations: default (self) + one alternate', async () => {
  const meta = {
    '@id': RES,
    [ALTR + 'hasDefaultRepresentation']: { '@id': RES, [DCT + 'format']: 'text/markdown', [DCT + 'conformsTo']: { '@id': CONTENT_P } },
    [ALTR + 'hasRepresentation']: { '@id': LINKS, [DCT + 'format']: 'application/ld+json', [DCT + 'conformsTo']: { '@id': LINKS_P } },
  };
  const reps = await readRepresentations(stubStorage(meta), RES + '.meta', RES);
  assert.deepEqual(reps.default, { href: RES, format: 'text/markdown', profile: CONTENT_P });
  assert.equal(reps.alternates.length, 1);
  assert.deepEqual(reps.alternates[0], { href: LINKS, format: 'application/ld+json', profile: LINKS_P });
});

test('readRepresentations: missing .meta → empty', async () => {
  const reps = await readRepresentations(stubStorage(null), RES + '.meta', RES);
  assert.deepEqual(reps, { default: null, alternates: [] });
});
