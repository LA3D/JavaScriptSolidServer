/**
 * Config surface for the LWS authorization-server role (2026-07-24 AS
 * round, task 1): --lws-as / --lws-as-uri / --lws-as-ttl (+ JSS_LWS_AS*
 * env), the --lws-as ⇒ --lws dependency, request decorations, and the
 * three new capability-report rows.
 *
 * This task only plumbs config through — the token-exchange grant,
 * /.well-known/lws-configuration metadata, and RS-side at+jwt validation
 * are later tasks in the round (see
 * docs/superpowers/plans/2026-07-24-authorization-server-round.md).
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { formatCapabilityReport } from '../src/lws/capability-report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'jss.js');
const DATA_DIR = './test-data-as-config';
// Timeout cap so the suite can never hang if a validator regresses and
// `start` actually tries to bind a port instead of exiting early
// (same guard as test/cli-flag-like-values.test.js).
const RUN_TIMEOUT_MS = 10_000;

function runCli(args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  assert.equal(r.signal, null,
    `CLI did not exit within ${RUN_TIMEOUT_MS}ms — args: ${JSON.stringify(args)}; partial stderr: ${r.stderr}`);
  return r;
}

// ---- (a) --lws-as requires --lws ---------------------------------------
describe('config — --lws-as requires --lws', () => {
  it('loadConfig() throws a clear error when --lws-as is set without --lws', async () => {
    await assert.rejects(
      () => loadConfig({ lwsAs: true }, null),
      /--lws-as requires --lws/
    );
  });

  it('loadConfig() accepts --lws-as together with --lws', async () => {
    const cfg = await loadConfig({ lwsAs: true, lws: true }, null);
    assert.equal(cfg.lwsAs, true);
  });

  it('createServer({ lwsAs: true }) without lws throws the same fail-fast error', () => {
    assert.throws(
      () => createServer({ lwsAs: true, root: DATA_DIR }),
      /--lws-as requires --lws/
    );
  });

  it('bin/jss.js start --lws-as (no --lws) exits non-zero with a clear stderr error', () => {
    const r = runCli(['start', '--lws-as', '--root', DATA_DIR]);
    assert.notEqual(r.status, 0, 'exit code should be non-zero');
    assert.match(r.stderr, /--lws-as requires --lws/);
  });

  it('bin/jss.js start --lws --lws-as --print-config exits cleanly (0)', () => {
    const r = runCli(['start', '--lws', '--lws-as', '--root', DATA_DIR, '--print-config']);
    assert.equal(r.status, 0, `expected clean exit, got ${r.status}; stderr: ${r.stderr}`);
  });
});

// ---- (b) env JSS_LWS_AS matches the flag --------------------------------
describe('config — JSS_LWS_AS env matches the flag', () => {
  const KEY = 'JSS_LWS_AS';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('JSS_LWS_AS=true enables lwsAs the same as --lws-as', async () => {
    process.env[KEY] = 'true';
    const cfgEnv = await loadConfig({ lws: true }, null);
    delete process.env[KEY];
    const cfgFlag = await loadConfig({ lws: true, lwsAs: true }, null);
    assert.equal(cfgEnv.lwsAs, true);
    assert.equal(cfgEnv.lwsAs, cfgFlag.lwsAs);
  });

  it('JSS_LWS_AS=false leaves lwsAs off', async () => {
    process.env[KEY] = 'false';
    const cfg = await loadConfig({ lws: true }, null);
    assert.equal(cfg.lwsAs, false);
  });
});

// ---- (c) lwsAsUri: self-origin default + explicit override -------------
describe('server — lwsAsUri resolution + request decorations', () => {
  before(async () => { await fs.ensureDir(DATA_DIR); });
  after(async () => { await fs.remove(DATA_DIR); });

  // Registers an onRequest hook AFTER createServer()'s own internal hook
  // (added during createServer()'s synchronous body, before it returns),
  // so this one runs second and observes the populated decorations —
  // same pattern test/nip98-payload-hash.test.js uses for createServer()
  // + .inject() without an actual listen().
  async function captureDecorations(options) {
    const server = createServer({ logger: false, root: DATA_DIR, ...options });
    let captured = null;
    server.addHook('onRequest', async (request) => {
      captured = { lwsAs: request.lwsAs, lwsAsUri: request.lwsAsUri };
    });
    await server.inject({ method: 'OPTIONS', url: '/' });
    await server.close();
    return captured;
  }

  it('defaults lwsAsUri to the deployment self-origin when --lws-as is on', async () => {
    const captured = await captureDecorations({ lws: true, lwsAs: true, host: '127.0.0.1', port: 5799 });
    assert.equal(captured.lwsAs, true);
    assert.equal(captured.lwsAsUri, 'http://127.0.0.1:5799');
  });

  it('honors an explicit --lws-as-uri', async () => {
    const captured = await captureDecorations({ lws: true, lwsAs: true, lwsAsUri: 'https://as.example' });
    assert.equal(captured.lwsAsUri, 'https://as.example');
  });

  it('falls back to self-origin when --lws-as-uri is not an absolute URI', async () => {
    const captured = await captureDecorations({
      lws: true, lwsAs: true, lwsAsUri: 'not-a-uri', host: '127.0.0.1', port: 5798,
    });
    assert.equal(captured.lwsAsUri, 'http://127.0.0.1:5798');
  });

  it('lwsAsUri stays null and lwsAs is false when --lws-as is off', async () => {
    const captured = await captureDecorations({ lws: true });
    assert.equal(captured.lwsAs, false);
    assert.equal(captured.lwsAsUri, null);
  });
});

// ---- (d) lwsAsTtl: default / override / non-numeric rejected -----------
describe('config — lwsAsTtl', () => {
  const KEY = 'JSS_LWS_AS_TTL';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('defaults to 300', async () => {
    delete process.env[KEY];
    const cfg = await loadConfig({ lws: true, lwsAs: true }, null);
    assert.equal(cfg.lwsAsTtl, 300);
  });

  it('an explicit override (CLI-shaped number) is honored', async () => {
    const cfg = await loadConfig({ lws: true, lwsAs: true, lwsAsTtl: 60 }, null);
    assert.equal(cfg.lwsAsTtl, 60);
  });

  it('JSS_LWS_AS_TTL coerces a numeric env string', async () => {
    process.env[KEY] = '120';
    const cfg = await loadConfig({ lws: true, lwsAs: true }, null);
    assert.equal(cfg.lwsAsTtl, 120);
    assert.equal(typeof cfg.lwsAsTtl, 'number');
  });

  it('a non-numeric TTL is rejected and falls back to the default (with a warning)', async () => {
    process.env[KEY] = 'banana';
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const cfg = await loadConfig({ lws: true, lwsAs: true }, null);
      assert.equal(cfg.lwsAsTtl, 300);
      assert.ok(warnings.some((w) => /lws-as-ttl|LWS_AS_TTL/i.test(w)),
        `expected a warning about the bad TTL; got: ${JSON.stringify(warnings)}`);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ---- (e) capability report rows -----------------------------------------
describe('capability report — lws-as rows', () => {
  it('lws-as ON shows as_uri + ttl', () => {
    const out = formatCapabilityReport(
      {
        lws: true, lwsTypeIndex: true, lwsProfileConneg: true, lwsConfig: null, mcp: true,
        lwsAs: true, lwsAsUri: 'https://pod.example', lwsAsTtl: 300,
      },
      { configResolved: true }
    );
    assert.match(out, /lws-as\s+ON\s+\(as_uri=https:\/\/pod\.example, ttl=300s\)/);
  });

  it('lws-as OFF when --lws is on but --lws-as is off', () => {
    const out = formatCapabilityReport(
      {
        lws: true, lwsTypeIndex: true, lwsProfileConneg: true, lwsConfig: null, mcp: true,
        lwsAs: false, lwsAsUri: null, lwsAsTtl: 300,
      },
      { configResolved: true }
    );
    assert.match(out, /lws-as\s+OFF/);
  });

  it('names the trusted-local direct-bearer path', () => {
    const out = formatCapabilityReport(
      {
        lws: true, lwsTypeIndex: true, lwsProfileConneg: true, lwsConfig: null, mcp: true,
        lwsAs: false, lwsAsUri: null, lwsAsTtl: 300,
      },
      { configResolved: true }
    );
    assert.match(out, /trusted-local direct bearer: ON/);
  });

  it('no lws-as / trusted-local rows when --lws is off', () => {
    const out = formatCapabilityReport({ lws: false, mcp: false }, {});
    assert.doesNotMatch(out, /lws-as/);
    assert.doesNotMatch(out, /trusted-local direct bearer/);
  });
});
