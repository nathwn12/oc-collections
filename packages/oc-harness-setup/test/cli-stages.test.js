/**
 * Staged setup wrapper: the six-stage registry, the additive flags, the
 * progress file, and the guarantee that plain `setup` is unchanged.
 *
 * Every run is hermetic: a scratch config dir under os.tmpdir() and a fake
 * `opencode` on PATH. No network, no live config, no external install.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import {
  fakePath, parseJsoncForTest, PKG_ROOT, readStageState, runCli, WIN_SKIP,
  writeFakeOpencode,
} from './helpers.js';

const EXPECTED_IDS = ['preflight', 'resolve', 'plan', 'write', 'verify', 'report'];

function registryFrom(text) {
  const out = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (/^-\s+id:/.test(t)) { cur = { id: t.replace(/^-\s+id:\s*/, '').trim(), title: '' }; out.push(cur); }
    else if (t.startsWith('title:') && cur) cur.title = t.slice(6).trim();
  }
  return out;
}

// A piped burst of answers is not how a person uses --ask: each answer is
// typed after its prompt appears. Feed one line when its prompt is seen, so
// readline always has a pending question when the line arrives.
function runAsk(env, cwd, answers) {
  const markers = ['Type y to continue', 'Keep your values', 'Install the playbook'];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(PKG_ROOT, 'bin', 'cli.js'), 'setup', '--ask'], {
      cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let sent = 0;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      while (sent < answers.length && out.includes(markers[sent])) {
        child.stdin.write(`${answers[sent++]}\n`);
      }
      if (sent === answers.length) child.stdin.end();
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (status) => resolve({ status, stdout: out, stderr: err }));
  });
}

function stageFixture(prefix) {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  const cfg = path.join(base, 'cfg');
  mkdirSync(cfg, { recursive: true });
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFakeOpencode(fakeBin);
  return { base, cfg, env: { OPENCODE_CONFIG_DIR: cfg, FAKE_OPENCODE_CONFIG: cfg, PATH: fakePath(fakeBin) } };
}

/* -------------------------------- test 1 ------------------------------ */

test('stage ids and titles come from stages.yaml and --list-stages prints them', { skip: WIN_SKIP }, () => {
  const registry = registryFrom(readFileSync(path.join(PKG_ROOT, 'stages.yaml'), 'utf8'));
  assert.deepEqual(registry.map((s) => s.id), EXPECTED_IDS, 'registry owns the six ids in order');
  assert.ok(registry.every((s) => s.title.length > 0), 'every stage has a title');

  const r = runCli(['--list-stages'], { input: '', cwd: PKG_ROOT });
  assert.equal(r.status, 0, `list-stages exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
  const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim());
  assert.deepEqual(lines.map((l) => l.trim().split(/\s+/)[0]), EXPECTED_IDS, 'ids print in registry order');
  for (const s of registry) assert.ok(lines.some((l) => l.includes(s.title)), `title ${s.title} is printed`);
});

/* -------------------------------- test 2 ------------------------------ */

test('--stage plan stops before any write', { skip: WIN_SKIP }, () => {
  const { base, cfg, env } = stageFixture('oc-stages-plan-');
  try {
    writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify({ model: 'adopter/model-1' }, null, 2));
    const r = runCli(['setup', '--stage', 'plan'], { env, input: 'y\n', cwd: base });
    assert.equal(r.status, 0, `stage plan exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.match(String(r.stdout || ''), /install manifest/, 'the plan stage ran');
    assert.ok(!String(r.stdout || '').includes('-------------------------------- summary'), 'no report stage');
    assert.ok(!existsSync(path.join(cfg, 'oc-harness-setup.manifest.json')), 'no manifest written');
    assert.ok(!existsSync(path.join(cfg, 'agents')), 'no files staged');
    assert.ok(!existsSync(path.join(cfg, 'state', 'setup-state.yaml')), 'no progress file before write');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- test 3 ------------------------------ */

test('--from verify skips the writes', { skip: WIN_SKIP }, () => {
  const { base, cfg, env } = stageFixture('oc-stages-from-');
  try {
    writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify({ model: 'adopter/model-1' }, null, 2));
    const r = runCli(['setup', '--from', 'verify'], { env, input: '', cwd: base });
    assert.equal(r.status, 0, `from verify exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.match(String(r.stdout || ''), /-------------------------------- summary/, 'the report stage ran');
    assert.ok(!existsSync(path.join(cfg, 'oc-harness-setup.manifest.json')), 'no manifest written');
    assert.ok(!existsSync(path.join(cfg, 'agents')), 'no files staged');
    const st = readStageState(cfg);
    assert.deepEqual(st.stages.map((s) => s.status),
      ['skipped', 'skipped', 'skipped', 'skipped', 'done', 'done'], 'only verify and report ran');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- test 4 ------------------------------ */

test('plain setup still runs all six stages and exits as before', { skip: WIN_SKIP }, () => {
  const { base, cfg, env } = stageFixture('oc-stages-plain-');
  try {
    writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify({ model: 'adopter/model-1' }, null, 2));
    const r = runCli(['setup'], { env, input: 'y\n', cwd: base });
    assert.equal(r.status, 0, `plain setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.match(String(r.stdout || ''), /-------------------------------- summary/, 'summary still printed');
    assert.ok(existsSync(path.join(cfg, 'oc-harness-setup.manifest.json')), 'manifest still written');
    const st = readStageState(cfg);
    assert.deepEqual(st.stages.map((s) => s.id), EXPECTED_IDS, 'all six rows in registry order');
    assert.ok(st.stages.every((s) => s.status === 'done'), 'every stage ran');
    assert.ok(st.stages.every((s) => /^\d{4}-\d{2}-\d{2}T/.test(s.at)), 'each row carries an ISO timestamp');
    assert.match(st.updated, /^\d{4}-\d{2}-\d{2}T/, 'updated is an ISO timestamp');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- test 5 ------------------------------ */

test('an unknown stage id exits 2 and names the valid ids', { skip: WIN_SKIP }, () => {
  const r = runCli(['setup', '--stage', 'nope'], { input: '', cwd: PKG_ROOT });
  assert.equal(r.status, 2, `unknown id exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  for (const id of EXPECTED_IDS) assert.ok(out.includes(id), `${id} named in the error`);
});

/* -------------------------------- test 6 ------------------------------ */

test('--ask with Enter keeps today\'s result', { skip: WIN_SKIP }, async () => {
  const { base, cfg, env } = stageFixture('oc-stages-ask-');
  try {
    writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify({
      model: 'adopter/model-1', default_agent: 'mine',
    }, null, 2));
    // y for the existing consent gate, then Enter for the two new defaults.
    const r = await runAsk(env, base, ['y', '', '']);
    assert.equal(r.status, 0, `ask exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    const out = String(r.stdout || '');
    assert.ok(out.includes('Keep your values for install-owned keys on collision?'), 'collision prompt asked');
    assert.ok(out.includes('Install the playbooks?'), 'playbook prompt asked');
    const merged = parseJsoncForTest(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8'));
    assert.equal(merged.default_agent, 'mine', 'Enter keeps the adopter collision value');
    const st = readStageState(cfg);
    assert.equal(st.collisionPolicy, 'keep', 'the chosen collision policy is recorded');
    assert.equal(st.installPlaybooks, 'true', 'the playbook choice is recorded');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- test 7 ------------------------------ */

// The retired-distro filter must read a V2 object's package, not String(entry).
test('older-prior upgrade drops an object entry for the retired distro plugin', { skip: WIN_SKIP }, () => {
  const { base, cfg, env } = stageFixture('oc-stages-retired-');
  try {
    writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify({
      plugins: [{ package: 'oc-flight-deck', options: { mode: 'strict' } }],
    }, null, 2));
    writeFileSync(path.join(cfg, 'oc-harness-setup.manifest.json'), JSON.stringify({
      package: 'oc-harness-setup', version: '0.4.1', created: new Date(0).toISOString(),
      configDir: cfg, files: [],
    }, null, 2));
    const r = runCli(['setup'], { env, input: 'y\n', cwd: base });
    assert.equal(r.status, 0, `upgrade exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    const merged = parseJsoncForTest(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8'));
    assert.deepEqual(merged.plugins || [], [], 'the retired distro id is dropped in object form too');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
