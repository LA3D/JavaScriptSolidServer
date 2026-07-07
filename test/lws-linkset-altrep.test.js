import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLinkset } from '../src/lws/linkset.js';

test('generateLinkset: emits canonical + alternate from representations', () => {
  const res = 'https://pod.example/alice/mem-a';
  const ls = generateLinkset(res, {
    representations: {
      default: { href: res, format: 'text/markdown', profile: 'https://p.example/content' },
      alternates: [{ href: res + '.links.jsonld', format: 'application/ld+json', profile: 'https://p.example/links' }],
    },
  });
  const link = ls.linkset[0];
  assert.deepEqual(link.canonical, [{ href: res, type: 'text/markdown', formats: 'https://p.example/content' }]);
  assert.deepEqual(link.alternate, [{ href: res + '.links.jsonld', type: 'application/ld+json', formats: 'https://p.example/links' }]);
});

test('generateLinkset: no representations → no canonical/alternate keys', () => {
  const ls = generateLinkset('https://pod.example/alice/mem-a', {});
  assert.equal('canonical' in ls.linkset[0], false);
  assert.equal('alternate' in ls.linkset[0], false);
});
