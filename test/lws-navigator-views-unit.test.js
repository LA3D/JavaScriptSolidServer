// test/lws-navigator-views-unit.test.js
// Final-review minor: renderContainerView's faces column ran
// esc(f.format) unconditionally — a face lacking a declared dct:format
// (readRepresentations/repFrom in src/lws/representations.js defaults
// format to null when the .meta rep node has no dct:format triple)
// rendered a literal "null" (or "undefined", for a face object missing the
// key outright) via String(f.format)/escapeHtml instead of omitting the
// entry. Pure unit test — no server, direct import.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderContainerView } from '../src/navigator/views.js';

describe('renderContainerView: faces column with a formatless alternate', () => {
  it('a face with format: null never renders a literal "null" label', () => {
    const html = renderContainerView({
      url: 'https://pod.example/alice/public/wiki/',
      items: [{
        id: 'https://pod.example/alice/public/wiki/a.md',
        type: 'DataResource',
        faces: [{ href: 'https://pod.example/alice/public/wiki/a.md.html', format: null }],
      }],
    });
    assert.doesNotMatch(html, />null</, 'a formatless face must not render a literal "null" label');
    assert.doesNotMatch(html, /a\.md\.html/, 'a formatless face is filtered out, not rendered with a fallback label');
  });

  it('a face with the format key entirely absent never renders a literal "undefined" label', () => {
    const html = renderContainerView({
      url: 'https://pod.example/alice/public/wiki/',
      items: [{
        id: 'https://pod.example/alice/public/wiki/a.md',
        type: 'DataResource',
        faces: [{ href: 'https://pod.example/alice/public/wiki/a.md.html' }],
      }],
    });
    assert.doesNotMatch(html, />undefined</, 'a formatless face must not render a literal "undefined" label');
  });

  it('a face WITH a declared format still renders its format label', () => {
    const html = renderContainerView({
      url: 'https://pod.example/alice/public/wiki/',
      items: [{
        id: 'https://pod.example/alice/public/wiki/a.md',
        type: 'DataResource',
        faces: [{ href: 'https://pod.example/alice/public/wiki/a.md.html', format: 'text/html' }],
      }],
    });
    assert.match(html, />text\/html</, 'a declared format must still render its label');
  });
});
