// S3 (spec 2026-07-10 §4): .lwstypes is a plain-JSON server sidecar — serve
// application/json, not application/octet-stream (probe-#3 affordance nit).
// NOT application/ld+json: it carries no @context; ld+json would over-claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getContentType } from '../src/utils/url.js';

test('.lwstypes sidecars serve application/json', () => {
  assert.equal(getContentType('/alice/notes/a.md.lwstypes'), 'application/json');
  assert.equal(getContentType('/alice/notes/.lwstypes'), 'application/json');
});

test('.meta/.acl overrides unchanged', () => {
  assert.equal(getContentType('/alice/notes/a.md.meta'), 'application/ld+json');
  assert.equal(getContentType('/alice/.acl'), 'application/ld+json');
});
