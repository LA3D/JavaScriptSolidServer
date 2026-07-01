// test/lws-constraint.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveShapeUrl } from '../src/lws/constraint.js';

const DESCRIBEDBY = 'http://www.w3.org/2007/05/powder-s#describedby';
// .meta is JSON-LD on disk: <subject> describedby <shape>
const metaJson = (subject, shape) => Buffer.from(JSON.stringify({
  '@id': subject, [DESCRIBEDBY]: { '@id': shape },
}));
const fakeStorage = (files) => ({
  async exists(p) { return p in files; },
  async read(p) { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
});

test('resolveShapeUrl: target .meta declares describedby → returns shape', async () => {
  const s = fakeStorage({ '/alice/x.meta': metaJson('http://h/alice/x', 'http://h/shapes/X.ttl') });
  const got = await resolveShapeUrl({ storage: s, targetMetaPath: '/alice/x.meta',
    containerMetaPath: '/alice/.meta', baseIri: 'http://h/alice/x' });
  assert.equal(got, 'http://h/shapes/X.ttl');
});

test('resolveShapeUrl: falls back to container .meta member-rule', async () => {
  const s = fakeStorage({ '/alice/.meta': metaJson('http://h/alice/', 'http://h/shapes/Member.ttl') });
  const got = await resolveShapeUrl({ storage: s, targetMetaPath: '/alice/new.meta',
    containerMetaPath: '/alice/.meta', baseIri: 'http://h/alice/' });
  assert.equal(got, 'http://h/shapes/Member.ttl');
});

test('resolveShapeUrl: no .meta anywhere → null (opt-in miss)', async () => {
  const got = await resolveShapeUrl({ storage: fakeStorage({}), targetMetaPath: '/alice/x.meta',
    containerMetaPath: '/alice/.meta', baseIri: 'http://h/alice/x' });
  assert.equal(got, null);
});

test('resolveShapeUrl: malformed JSON-LD in .meta → null (parse-corrupt treated as unconstrained)', async () => {
  const s = fakeStorage({ '/alice/x.meta': Buffer.from('{ this is not valid json-ld') });
  const got = await resolveShapeUrl({ storage: s, targetMetaPath: '/alice/x.meta',
    containerMetaPath: '/alice/.meta', baseIri: 'http://h/alice/x' });
  assert.equal(got, null);
});

import { describedbyTargets } from '../src/lws/constraint.js';

const metaTwo = (subject, ...shapes) => Buffer.from(JSON.stringify({
  '@id': subject, [DESCRIBEDBY]: shapes.map((s) => ({ '@id': s })),
}));

test('describedbyTargets: returns all shape targets in the .meta', async () => {
  const s = fakeStorage({ '/alice/x.meta': metaTwo('http://h/alice/x', 'http://h/shapes/A', 'http://h/shapes/B') });
  const got = await describedbyTargets(s, '/alice/x.meta', 'http://h/alice/x');
  assert.deepEqual(got.sort(), ['http://h/shapes/A', 'http://h/shapes/B']);
});

test('describedbyTargets: single target', async () => {
  const s = fakeStorage({ '/alice/x.meta': metaJson('http://h/alice/x', 'http://h/shapes/X.ttl') });
  assert.deepEqual(await describedbyTargets(s, '/alice/x.meta', 'http://h/alice/x'), ['http://h/shapes/X.ttl']);
});

test('describedbyTargets: no .meta → []', async () => {
  assert.deepEqual(await describedbyTargets(fakeStorage({}), '/alice/x.meta', 'http://h/alice/x'), []);
});

test('describedbyTargets: malformed .meta → [] (unconstrained)', async () => {
  const s = fakeStorage({ '/alice/x.meta': Buffer.from('{ not json-ld') });
  assert.deepEqual(await describedbyTargets(s, '/alice/x.meta', 'http://h/alice/x'), []);
});
