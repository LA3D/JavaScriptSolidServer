import { test, describe } from 'node:test';
import assert from 'node:assert';
import { formatCapabilityReport } from '../src/lws/capability-report.js';

describe('capability report', () => {
  test('names a missing lws-config and the services it disables', () => {
    const out = formatCapabilityReport(
      { lws: true, lwsTypeIndex: true, lwsProfileConneg: true, lwsConfig: '/alice/profiles/pod-config.jsonld', mcp: true },
      { configResolved: false }
    );
    assert.match(out, /lws-config/);
    assert.match(out, /NOT FOUND/);
    assert.match(out, /profileIndex\/void\/uriSpaces services OFF/);
  });

  test('marks implied sub-features as implied', () => {
    const out = formatCapabilityReport(
      { lws: true, lwsTypeIndex: true, lwsProfileConneg: true, lwsConfig: null, mcp: false },
      { configResolved: true }
    );
    assert.match(out, /type-index\s+ON\s+\(implied by --lws\)/);
  });
});
