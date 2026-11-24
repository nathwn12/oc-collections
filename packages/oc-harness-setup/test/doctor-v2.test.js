/**
 * V2 host-output regressions for the REAL harness-doctor.
 *
 * Two defects from OpenCode 2.4.1 host output are pinned here:
 *   - `opencode mcp list` marks a disabled server with a leading ○ (U+25CB).
 *     The doctor must strip that marker and read the real server name, while
 *     keeping the both-directions set comparison fail-closed.
 *   - A V2 plugin may be `{ package, options }`. The doctor must read `package`
 *     as its identity instead of stringifying the object to '[object Object]'.
 *
 * Every run grades the real scripts/harness-doctor.mjs copied into a scratch
 * config dir, driven by a hermetic fake `opencode` on PATH. No network, no
 * live config, no services, no credentials.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakePath, makeDoctorFixture, PKG_ROOT, WIN_SKIP } from './helpers.js';

// Proof the law names below come from the real doctor, not a restatement.
assert.match(readFileSync(path.join(PKG_ROOT, 'scripts', 'harness-doctor.mjs'), 'utf8'), /getRegistryMcpNames/);

// Hermetic V2 `opencode`: only the commands the doctor calls, no network.
function writeV2FakeOpencode(binDir) {
  writeFileSync(
    path.join(binDir, 'fake-opencode.mjs'),
    [
      'const a = process.argv.slice(2);',
      "const out = (s) => process.stdout.write(s + '\\n');",
      "if (a[0] === '--version') out('opencode v2.4.1');",
      "else if (a[0] === 'debug' && a[1] === 'config') out(JSON.stringify([{ type: 'document', path: (process.env.FAKE_CONFIG ?? '') + '/opencode.jsonc' }]));",
      "else if (a[0] === 'debug' && a[1] === 'agents') out(JSON.stringify([{ id: 'orchestrator', name: 'Orchestrator', mode: 'primary' }]));",
      "else if (a[0] === 'plugin' && a[1] === 'list') { out('ID                 VERSION  SOURCE'); for (const n of (process.env.FAKE_PLUGINS ?? '').split(/[,\\s]+/).filter(Boolean)) out(n + '  2.4.1  ' + n); }",
      "else if (a[0] === 'mcp' && a[1] === 'list') { for (const r of JSON.parse(process.env.FAKE_MCP_JSON ?? '[]')) out(r); }",
      "else { process.stderr.write('fake opencode: unknown args ' + a.join(' ') + '\\n'); process.exitCode = 1; }",
    ].join('\n')
  );
  writeFileSync(path.join(binDir, 'opencode.cmd'), `@echo off\r\nnode "%~dp0fake-opencode.mjs" %*\r\n`);
}

// Permissions that satisfy every declared gate for the one-agent / one-skill
// fixture makeDoctorFixture builds, so no unrelated fixture law goes red.
function fixturePermissions() {
  const deny = (action, contains) => ({ action, resource: `*${contains}*`, effect: 'deny' });
  return [
    { action: 'skill', resource: '*', effect: 'deny' },
    { action: 'skill', resource: 'x', effect: 'allow' },
    deny('shell', 'Format-Volume'),
    deny('shell', 'Clear-Disk'),
    ...['secrets', '.env', 'service.json'].flatMap((s) =>
      ['read', 'edit', 'external_directory', 'shell'].map((action) => deny(action, s))),
  ];
}

function grade(base, configObject, { mcpLines, pluginRows }) {
  const cfg = makeDoctorFixture(base, configObject);
  // Law 8 accepts an unwired routing state when a .docs record documents it.
  mkdirSync(path.join(cfg, '.docs'), { recursive: true });
  writeFileSync(path.join(cfg, '.docs', 'unwired.md'), 'Model routing is currently unwired.\n');
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeV2FakeOpencode(fakeBin);
  const r = spawnSync(process.execPath, [path.join(cfg, 'scripts', 'harness-doctor.mjs'), '-ConfigDir', cfg], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: fakePath(fakeBin),
      FAKE_CONFIG: cfg,
      FAKE_PLUGINS: pluginRows.join(' '),
      FAKE_MCP_JSON: JSON.stringify(mcpLines),
    },
  });
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

// The disabled marker and the V2 object both resolve to the real identity, so
// a config that agrees with the V2 registry grades clean on the real doctor.
test('real doctor accepts a V2 disabled-MCP marker and a V2 plugin object', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-v2-ok-'));
  try {
    const config = {
      default_agent: 'orchestrator',
      permissions: fixturePermissions(),
      mcp: { servers: { bladebro: { type: 'local', command: ['node', 'x'] } } },
      plugins: [{ package: 'bladebro-plugin', options: { strict: true } }],
    };
    const { status, out } = grade(base, config, {
      mcpLines: ['NAME                 STATUS', '○ bladebro  disabled'],
      pluginRows: ['bladebro-plugin'],
    });
    assert.equal(status, 0, `an agreeing V2 config must grade clean:\n${out}`);
    assert.ok(!out.includes('[FAIL]'), `no law may fail:\n${out}`);
    assert.ok(out.includes('[PASS] every configured plugin resolves in the registry'), `plugin law passes:\n${out}`);
    assert.ok(out.includes('[PASS] configured MCP servers match the registry both directions'), `MCP law passes:\n${out}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Stripping the marker must not weaken the set comparison: a real mismatch
// still fails in both directions, and the marker is never read as a server ID.
test('real doctor still fails both MCP directions on a V2 registry mismatch', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-v2-bad-'));
  try {
    const config = {
      default_agent: 'orchestrator',
      permissions: fixturePermissions(),
      mcp: { servers: { 'other-server': { type: 'local', command: ['node', 'x'] } } },
      plugins: [{ package: 'bladebro-plugin', options: { strict: true } }],
    };
    const { status, out } = grade(base, config, {
      mcpLines: ['NAME                 STATUS', '○ bladebro  disabled'],
      pluginRows: ['bladebro-plugin'],
    });
    assert.equal(status, 1, `a registry mismatch must remain a real regression:\n${out}`);
    assert.ok(out.includes("declared server 'other-server' is not registered"), `declared -> registered direction fails:\n${out}`);
    assert.ok(out.includes('registered servers not declared in opencode.jsonc: bladebro'), `registered -> declared direction fails on the real name:\n${out}`);
    assert.ok(!out.includes('registered servers not declared in opencode.jsonc: ○'), 'the ○ marker is never treated as a server ID');
    assert.ok(out.includes('[PASS] every configured plugin resolves in the registry'), `plugin law is unaffected:\n${out}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
