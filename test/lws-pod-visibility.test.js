/**
 * Per-storage visibility flag (Task A9, multi-tenant round).
 *
 * A pod can be provisioned public-read (default, discoverable) or
 * owner-only-private. Private means the root .acl carries no `#public`
 * foaf:Agent Read authorization — see src/wac/parser.js#generateOwnerAcl
 * and src/handlers/container.js#createPodStructure.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateOwnerAcl } from '../src/wac/parser.js';
import {
  startTestServer,
  stopTestServer,
  request
} from './helpers.js';

describe('generateOwnerAcl visibility option', () => {
  it('public (default) root ACL grants foaf:Agent Read', () => {
    const acl = generateOwnerAcl('./', 'http://h/alice/profile/card#me', true);
    assert.ok(JSON.stringify(acl).includes('foaf:Agent'));
    assert.ok(JSON.stringify(acl).includes('#public'));
  });

  it('private root ACL omits the #public authorization', () => {
    const acl = generateOwnerAcl('./', 'http://h/bob/profile/card#me', true, { publicRead: false });
    assert.ok(!JSON.stringify(acl).includes('#public'));
    assert.ok(!JSON.stringify(acl).includes('foaf:Agent'));
  });

  it('private root ACL still grants the owner Read/Write/Control', () => {
    const acl = generateOwnerAcl('./', 'http://h/bob/profile/card#me', true, { publicRead: false });
    const json = JSON.stringify(acl);
    assert.ok(json.includes('#owner'));
    assert.ok(json.includes('acl:Read'));
    assert.ok(json.includes('acl:Write'));
    assert.ok(json.includes('acl:Control'));
    // acl:default is still present on #owner for containers
    assert.ok(json.includes('acl:default'));
  });

  it('omitting the options arg is byte-identical to the pre-existing 3-arg call', () => {
    const withoutOptions = generateOwnerAcl('./', 'http://h/alice/profile/card#me', true);
    const withDefaultOptions = generateOwnerAcl('./', 'http://h/alice/profile/card#me', true, {});
    assert.deepEqual(withoutOptions, withDefaultOptions);
  });
});

describe('Pod provisioning visibility (HTTP)', () => {
  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
  });

  it('defaults to public: anon GET of the pod root succeeds', async () => {
    const res = await request('/.pods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pubvis' })
    });
    assertStatus201(res);

    const anon = await request('/pubvis/');
    assert.equal(anon.status, 200);
  });

  it('visibility: private makes the root ACL owner-only — anon 401s, owner 200s', async () => {
    const res = await request('/.pods', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'privvis', visibility: 'private' })
    });
    assertStatus201(res);
    const { token } = await res.json();

    const anon = await request('/privvis/');
    assert.equal(anon.status, 401);

    const owner = await request('/privvis/', {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(owner.status, 200);
  });
});

function assertStatus201(res) {
  if (res.status !== 201) {
    throw new Error(`Expected 201, got ${res.status}`);
  }
}
