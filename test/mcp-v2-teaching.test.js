// test/mcp-v2-teaching.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admissionError } from '../src/mcp/errors.js';
import { callTool } from '../src/mcp/tools.js';
import { startLwsPod, ownerCtx, putShape, putContainerMeta } from './helpers.js';

const NOTE_SHAPE = {
  '@context': { sh: 'http://www.w3.org/ns/shacl#', ex: 'http://ex/' },
  '@id': 'http://ex/NoteShape', '@type': 'sh:NodeShape',
  'sh:targetClass': { '@id': 'http://ex/Note' },
  'sh:property': {
    '@id': '_:p1', 'sh:path': { '@id': 'http://ex/title' }, 'sh:minCount': 1,
    'sh:severity': { '@id': 'http://www.w3.org/ns/shacl#Violation' },
    'sh:message': 'title required',
  },
};

test('admissionError puts sh:message + shape URI in the content text', () => {
  const e = admissionError('/a/b', {
    shapeUrl: 'http://ex/NoteShape',
    violations: [{ severity: 'Violation', message: 'title required', path: 'http://ex/title', focusNode: 'http://ex/n', value: null }],
  });
  assert.equal(e.isError, true);
  const text = e.content[0].text;
  assert.match(text, /title required/);
  assert.match(text, /http:\/\/ex\/NoteShape/);
  assert.match(text, /http:\/\/ex\/title/);
  assert.deepEqual(e.data.violations.length, 1);
});

test('write_resource reject surfaces the teaching content (not just "admission rejected")', async (t) => {
  const pod = await startLwsPod(t);
  const ctx = { ...ownerCtx(pod), lwsEnabled: true };
  await putShape(pod, `/${pod.podName}/shapes/note`, NOTE_SHAPE);
  await putContainerMeta(pod, `/${pod.podName}/notes/`, { describedby: `/${pod.podName}/shapes/note` });

  const res = await callTool('write_resource', {
    path: `/${pod.podName}/notes/bad`,
    content: JSON.stringify({ '@context': { ex: 'http://ex/' }, '@id': `${pod.base}/${pod.podName}/notes/bad`, '@type': 'ex:Note' }),
    contentType: 'application/ld+json',
  }, ctx);

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /title required/);   // the sh:message reaches the model
});
