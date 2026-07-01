// test/lws-type-metadata.test.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import * as storage from '../src/storage/filesystem.js';
import { parseTypeLinks, typeStorePath, captureDeclaredTypes, readDeclaredTypes } from '../src/lws/type-metadata.js';

describe('parseTypeLinks', () => {
  it('extracts rel="type" targets, ignores other rels', () => {
    const h = '<https://schema.org/Person>; rel="type", </alice/>; rel="up", <http://ex/Note>; rel="type"';
    assert.deepEqual(parseTypeLinks(h), ['https://schema.org/Person', 'http://ex/Note']);
  });
  it('ignores non-absolute targets and empty header', () => {
    assert.deepEqual(parseTypeLinks(''), []);
    assert.deepEqual(parseTypeLinks('<relative>; rel="type"'), []);
  });
});

describe('type store round-trip', () => {
  beforeEach(async () => { await fs.emptyDir('./data'); await storage.write('/foo', Buffer.from('x')); });
  it('typeStorePath appends .lwstypes', () => {
    assert.equal(typeStorePath('/alice/foo'), '/alice/foo.lwstypes');
  });
  it('captures and reads back declared types', async () => {
    await captureDeclaredTypes(storage, '/foo', ['https://schema.org/Person']);
    assert.deepEqual(await readDeclaredTypes(storage, '/foo'), ['https://schema.org/Person']);
  });
  it('missing store reads as empty array', async () => {
    assert.deepEqual(await readDeclaredTypes(storage, '/nope'), []);
  });
  it('empty capture writes nothing', async () => {
    await captureDeclaredTypes(storage, '/foo', []);
    assert.equal(await storage.exists(typeStorePath('/foo')), false);
  });
});
