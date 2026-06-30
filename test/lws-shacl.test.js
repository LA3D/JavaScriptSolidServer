// test/lws-shacl.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, datasetFromTurtle } from '../src/lws/shacl.js';

const SHAPE = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://ex/> .
ex:S a sh:NodeShape ; sh:targetClass ex:Note ;
  sh:property [ sh:path ex:title ; sh:minCount 1 ;
                sh:severity sh:Violation ; sh:message "title required" ] ;
  sh:property [ sh:path ex:desc  ; sh:minCount 1 ;
                sh:severity sh:Info ; sh:message "consider a description" ] .`;
const GOOD = `@prefix ex: <http://ex/> . ex:n a ex:Note ; ex:title "t" ; ex:desc "d" .`;
const BAD  = `@prefix ex: <http://ex/> . ex:n a ex:Note ; ex:desc "d" .`;        // missing title
const INFO = `@prefix ex: <http://ex/> . ex:n a ex:Note ; ex:title "t" .`;       // missing desc (Info)

test('validate: conforming graph → conforms true, no results', async () => {
  const r = await validate(datasetFromTurtle(GOOD, 'http://ex/'), datasetFromTurtle(SHAPE, 'http://ex/'));
  assert.equal(r.conforms, true);
  assert.equal(r.results.length, 0);
});

test('validate: missing required → Violation result with message+path', async () => {
  const r = await validate(datasetFromTurtle(BAD, 'http://ex/'), datasetFromTurtle(SHAPE, 'http://ex/'));
  assert.equal(r.conforms, false);
  const v = r.results.find(x => x.severity === 'Violation');
  assert.ok(v, 'has a Violation');
  assert.equal(v.message, 'title required');
  assert.equal(v.path, 'http://ex/title');
});

test('validate: missing optional → Info severity, still reported', async () => {
  const r = await validate(datasetFromTurtle(INFO, 'http://ex/'), datasetFromTurtle(SHAPE, 'http://ex/'));
  const i = r.results.find(x => x.severity === 'Info');
  assert.ok(i, 'has an Info');
  assert.equal(i.message, 'consider a description');
});
