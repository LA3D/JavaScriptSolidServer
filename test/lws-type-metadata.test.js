// test/lws-type-metadata.test.js
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import * as storage from '../src/storage/filesystem.js';
import { parseTypeLinks, typeStorePath, captureDeclaredTypes, readDeclaredTypes } from '../src/lws/type-metadata.js';
import { walkResources } from '../src/storage/filesystem.js';

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

describe('walkResources', () => {
  beforeEach(async () => {
    await fs.emptyDir('./data');
    await storage.write('/a', Buffer.from('x'));
    await storage.createContainer('/sub/');
    await storage.write('/sub/b', Buffer.from('y'));
    await storage.write('/a.lwstypes', Buffer.from('[]'));   // auxiliary — must be skipped
    await storage.write('/a.acl', Buffer.from('x'));         // auxiliary — must be skipped
  });
  it('lists files + containers, skips auxiliaries', async () => {
    const paths = (await walkResources('/')).map((r) => r.urlPath).sort();
    assert.deepEqual(paths, ['/a', '/sub/', '/sub/b']);
  });
});
