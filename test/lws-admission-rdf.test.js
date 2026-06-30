// test/lws-admission-rdf.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDataset, isRdfBody } from '../src/lws/admission-rdf.js';

const B = 'http://localhost:3000/alice/';

test('isRdfBody: turtle and json-ld are RDF, octet-stream is not', () => {
  assert.equal(isRdfBody('text/turtle'), true);
  assert.equal(isRdfBody('application/ld+json'), true);
  assert.equal(isRdfBody('text/n3'), true);
  assert.equal(isRdfBody('application/octet-stream'), false);
  assert.equal(isRdfBody(''), false);
});

test('toDataset: parses turtle into quads', async () => {
  const ds = await toDataset(Buffer.from('@prefix ex: <http://ex/> . ex:a ex:b ex:c .'), 'text/turtle', B);
  assert.equal([...ds].length, 1);
});

test('toDataset: parses json-ld into quads', async () => {
  const jsonld = JSON.stringify({ '@id': 'http://ex/a', 'http://ex/b': { '@id': 'http://ex/c' } });
  const ds = await toDataset(Buffer.from(jsonld), 'application/ld+json', B);
  assert.equal([...ds].length, 1);
});
