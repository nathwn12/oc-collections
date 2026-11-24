/**
 * Law 19 regressions for the REAL harness-doctor.
 *
 * The playbook law grades playbooks/*.md (Entry criteria -> ### heading ->
 * two numbered steps -> **Reply:**, in that order) and cross-checks those
 * names against the router table in skills/playbook/SKILL.md in both
 * directions. A config with no playbooks/ is a supported state: the law
 * passes with "no playbooks shipped", so this lane cannot go red just
 * because the playbook-install lane has not run yet.
 *
 * Every fixture run copies the real scripts/harness-doctor.mjs into a
 * scratch config dir and drives it with a hermetic fake `opencode` on PATH.
 * The real-tree check grades the installed config dir as-is. No network,
 * no services, no credentials, no writes outside a temp base.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakePath, makeDoctorFixture, PKG_ROOT, WIN_SKIP } from './helpers.js';

const LAW = 'playbooks carry the graded shape and match the router';

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

// Permissions that satisfy every other declared law for the one-agent /
// one-skill fixture makeDoctorFixture builds, so only Law 19 can go red.
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

function fixtureConfig(router) {
  const permissions = fixturePermissions();
  // A router is a real skill dir: give it the same allow the shipped tree
  // needs so the allowlist laws stay green and only Law 19 can go red.
  if (router) permissions.push({ action: 'skill', resource: 'playbook', effect: 'allow' });
  return {
    default_agent: 'orchestrator',
    permissions,
    mcp: { servers: { bladebro: { type: 'local', command: ['node', 'x'] } } },
    plugins: [{ package: 'bladebro-plugin', options: { strict: true } }],
  };
}

function writePlaybook(cfg, name, text) {
  mkdirSync(path.join(cfg, 'playbooks'), { recursive: true });
  writeFileSync(path.join(cfg, 'playbooks', `${name}.md`), text);
}

function validPlaybook(name) {
  return [
    `# ${name}`,
    '',
    'Entry criteria: a request arrives',
    '',
    '### Steps',
    '',
    '1. Read the request',
    '2. Grade the result',
    '',
    `**Reply:** ${name} complete`,
    '',
  ].join('\n');
}

function writeRouter(cfg, names) {
  // The router is a real skill with a command entry point (Law 17).
  mkdirSync(path.join(cfg, 'commands'), { recursive: true });
  writeFileSync(path.join(cfg, 'commands', 'playbook.md'), '---\ndescription: playbook router command\n---\n# playbook\n');
  mkdirSync(path.join(cfg, 'skills', 'playbook'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'skills', 'playbook', 'SKILL.md'),
    [
      '---',
      'name: playbook',
      'description: playbook router',
      '---',
      '# playbook',
      '',
      '| Trigger | Playbook |',
      '| --- | --- |',
      ...names.map((name) => `| ${name} | playbooks/${name}.md |`),
      '',
    ].join('\n')
  );
}

function grade(base, arrange, router = false) {
  const cfg = makeDoctorFixture(base, fixtureConfig(router));
  // Law 8 accepts an unwired routing state when a .docs record documents it.
  mkdirSync(path.join(cfg, '.docs'), { recursive: true });
  writeFileSync(path.join(cfg, '.docs', 'unwired.md'), 'Model routing is currently unwired.\n');
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeV2FakeOpencode(fakeBin);
  arrange(cfg);
  const r = spawnSync(process.execPath, [path.join(cfg, 'scripts', 'harness-doctor.mjs'), '-ConfigDir', cfg], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: fakePath(fakeBin),
      FAKE_CONFIG: cfg,
      FAKE_PLUGINS: 'bladebro-plugin',
      FAKE_MCP_JSON: JSON.stringify(['NAME                 STATUS', '○ bladebro  disabled']),
    },
  });
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

// The acceptance red: remove only the Reply line and the doctor must FAIL,
// naming both the file and the missing element.
test('real doctor fails a playbook missing its Reply line', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-playbook-reply-'));
  try {
    const { status, out } = grade(base, (cfg) => {
      writePlaybook(cfg, 'alpha', validPlaybook('alpha').replace('**Reply:** alpha complete\n', ''));
      writeRouter(cfg, ['alpha']);
    }, true);
    assert.equal(status, 1, `a playbook missing its Reply line must be a real regression:\n${out}`);
    assert.ok(out.includes(`[FAIL] ${LAW} - alpha.md: missing **Reply:** line`), `names file and missing element:\n${out}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Fail-closed PASS: no playbooks/ shipped is a supported state, and no
// router is needed for that verdict (ordering with the install lane).
test('real doctor passes with no playbooks shipped', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-playbook-none-'));
  try {
    const { status, out } = grade(base, () => {});
    assert.equal(status, 0, `no playbooks must grade clean:\n${out}`);
    assert.ok(out.includes(`[PASS] ${LAW} - no playbooks shipped`), `fail-closed PASS detail:\n${out}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Happy path with files: the ordered elements and both router directions
// agree, so the law passes rather than failing every tree that has playbooks.
test('real doctor passes a well-formed playbook and router', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-playbook-ok-'));
  try {
    const { status, out } = grade(base, (cfg) => {
      writePlaybook(cfg, 'alpha', validPlaybook('alpha'));
      writeRouter(cfg, ['alpha']);
    }, true);
    assert.equal(status, 0, `a well-formed playbook and router must grade clean:\n${out}`);
    assert.ok(out.includes(`[PASS] ${LAW} - `), `playbook law passes:\n${out}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Negative cross-check: a router row naming a file that does not ship is a
// dangling failure, named by the doctor.
test('real doctor fails a dangling router row', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-playbook-dangling-'));
  try {
    const { status, out } = grade(base, (cfg) => {
      writePlaybook(cfg, 'alpha', validPlaybook('alpha'));
      writeRouter(cfg, ['alpha', 'ghost']);
    }, true);
    assert.equal(status, 1, `a dangling router row must be a real regression:\n${out}`);
    assert.ok(out.includes('dangling router rows with no playbook: ghost.md'), `names the dangling file:\n${out}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The other cross-check direction: a playbook with no router row is an orphan.
test('real doctor fails an orphan playbook', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-playbook-orphan-'));
  try {
    const { status, out } = grade(base, (cfg) => {
      writePlaybook(cfg, 'alpha', validPlaybook('alpha'));
      writeRouter(cfg, []);
    }, true);
    assert.equal(status, 1, `an orphan playbook must be a real regression:\n${out}`);
    assert.ok(out.includes('orphan playbooks with no router row: alpha.md'), `names the orphan file:\n${out}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// The real shipped tree must pass this law against the installed config dir.
test('real shipped tree passes the playbook law', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const root = path.join(process.env.USERPROFILE ?? '', '.config', 'opencode');
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, 'scripts', 'harness-doctor.mjs'), '-ConfigDir', root], {
    encoding: 'utf8',
  });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.ok(out.includes(`[PASS] ${LAW} - `), `the installed tree must pass the playbook law:\n${out}`);
  assert.ok(!out.includes(`[FAIL] ${LAW} - `), `the installed tree must not fail the playbook law:\n${out}`);
});
