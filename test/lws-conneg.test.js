import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectContentType, RDF_TYPES } from '../src/rdf/conneg.js';

test('lws+json is a known RDF type', () => {
  assert.equal(RDF_TYPES.LWS_JSON, 'application/lws+json');
});

test('explicit Accept: application/lws+json is selected', () => {
  assert.equal(selectContentType('application/lws+json', false), 'application/lws+json');
});

test('absent lws+json, behavior is unchanged (defaults to JSON-LD)', () => {
  assert.equal(selectContentType('text/turtle', false), RDF_TYPES.JSON_LD); // conneg off
  assert.equal(selectContentType('application/ld+json', false), RDF_TYPES.JSON_LD);
});

test('linkset+json is a known RDF type and is negotiable', () => {
  assert.equal(RDF_TYPES.LINKSET, 'application/linkset+json');
  assert.equal(selectContentType('application/linkset+json', false), 'application/linkset+json');
});

test('linkset+json fires before connegEnabled guard — true flag also returns linkset+json', () => {
  assert.equal(selectContentType('application/linkset+json', true), 'application/linkset+json');
});
