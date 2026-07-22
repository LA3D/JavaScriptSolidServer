import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPodPath, urlToPath } from '../src/utils/url.js';

// PERMANENT REGRESSION GUARD for the sidecar-authz bug class (2026-07-21 round).
//
// Three separate CRITICAL privilege escalations in that round had ONE root cause:
// authorization was decided against one form of a path while the storage operation
// acted on another form (a trailing slash, a %2F, a %2E the storage layer would
// decode). The structural fix is that the MCP authz boundary canonicalizes a path
// with canonicalPodPath() before both the WAC check and the operation.
//
// That fix rests entirely on ONE invariant:
//
//     urlToPath(canonicalPodPath(X)) === urlToPath(X)   for every X
//
// i.e. canonicalizing must never change WHICH filesystem node the request resolves
// to. If it ever does, the guard and the operation can disagree again and the whole
// class reopens. canonicalPodPath and urlToPath each reproduce path-normalization
// rules by hand, in different code — nothing but this test forces them to agree, and
// three Criticals came from exactly "two things must agree" drifting apart. This test
// converts that invariant from a comment into something the suite defends.
describe('sidecar path-canonicalization invariant', () => {
  test('urlToPath(canonicalPodPath(X)) === urlToPath(X) over an adversarial corpus', () => {
    const names = ['victim', 'victim.acl', 'victim.meta', 'victim.lwstypes', 'v', 'a.b'];
    const mutators = [
      (s) => s, (s) => s + '/', (s) => s + '//', (s) => s + '///', (s) => s + '/.', (s) => s + '/./',
      (s) => s + '%2F', (s) => s + '%2f', (s) => s + '%2F%2E', (s) => s + '%2f%2e',
      (s) => s + '%252F', (s) => s + '%25252F', (s) => s + '%2525',
      (s) => s + '%2E', (s) => s + '%2e', (s) => s + '.', (s) => s + '..',
      (s) => s + '%00', (s) => s + '%0A', (s) => s + '%20', (s) => s + '\\', (s) => s + '%5C',
      (s) => s + '%C0%AF', (s) => s + '%E0%80%AF', (s) => s + '%ef%bc%8f', (s) => s + '⁄',
      (s) => s + '%', (s) => s + '%2', (s) => s + '%zz', (s) => s + '%%2e',
      (s) => '%2E/' + s, (s) => './' + s, (s) => './/' + s, (s) => 'x/../' + s, (s) => 'x/%2E%2E/' + s,
      (s) => s.replace('v', '%76'), (s) => s.replace('i', '%69'), (s) => s.replace('t', '%74'),
      (s) => s.toUpperCase(), (s) => s + '%2Facl', (s) => s + '%2F..', (s) => s + '/%2E',
      (s) => s + '%252E', (s) => '//' + s, (s) => '/./' + s, (s) => s + '%2F%2F',
    ];

    // A "disagreement" is any X where canonicalizing changes the resolved node — the
    // exact condition under which the guard and the operation can act on different files.
    // urlToPath may throw on malformed input (e.g. bare `%`); a throw on BOTH sides is
    // agreement (both fail closed), a throw on only one side is a disagreement.
    const resolve = (p) => {
      try { return urlToPath(p); } catch (e) { return `<throw:${e.constructor.name}>`; }
    };

    const disagreements = [];
    for (const n of names) {
      for (const m of mutators) {
        const input = `/pod/inbox/${m(n)}`;
        const direct = resolve(input);
        const viaCanon = resolve(canonicalPodPath(input));
        if (direct !== viaCanon) {
          disagreements.push({ input, canon: canonicalPodPath(input), direct, viaCanon });
        }
      }
    }

    assert.deepEqual(
      disagreements, [],
      `canonicalPodPath changed the resolved node for ${disagreements.length} input(s) — ` +
      `the guard/operation path-disagreement bug class has reopened:\n` +
      disagreements.map((d) =>
        `  in=${JSON.stringify(d.input)} canon=${JSON.stringify(d.canon)} ` +
        `urlToPath(in)=${d.direct} urlToPath(canon)=${d.viaCanon}`).join('\n'),
    );
  });

  test('canonicalPodPath is idempotent', () => {
    const cases = [
      '/a/b', '/a/b/', '/a%2Fb', '/a%252Fb', '/a/./b', '/a//b', '/a/..', '/',
      '/a%2E%2Eb', '/a%2F%2E%2E%2Fb', '/%2E%2E/etc', '/a%25252Fb',
    ];
    for (const c of cases) {
      const once = canonicalPodPath(c);
      assert.equal(canonicalPodPath(once), once, `not idempotent: ${JSON.stringify(c)} -> ${JSON.stringify(once)}`);
    }
  });

  test('no input escapes the pod data root', () => {
    const root = urlToPath('/');
    const climbs = [
      '/pod/../etc/passwd', '/pod/%2E%2E/etc', '/pod/%2E%2E%2Fetc',
      '/pod/....//etc', '/pod/%252E%252E/etc', '/pod/..%2Fetc', '/pod/a/../../etc',
    ];
    for (const c of climbs) {
      let fs;
      try { fs = urlToPath(canonicalPodPath(c)); } catch { continue; } // a throw is fail-closed
      assert.ok(fs.startsWith(root), `${JSON.stringify(c)} escaped the pod root: ${fs}`);
    }
  });
});
