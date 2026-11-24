/**
 * Evolve subcommand proof. Real CLI, scratch config dir, hermetic fake host.
 * No network, no live config, no external install. Every doctor run is the
 * real scripts/harness-doctor.mjs staged by a prior setup into the scratch dir.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CLI, fakePath, parseJsoncForTest, runCli, WIN_SKIP, writeFakeOpencode,
} from './helpers.js';

const LAW19 = '[PASS] playbooks carry the graded shape and match the router';

function evolveFixture(prefix) {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  const cfg = path.join(base, 'cfg');
  mkdirSync(cfg, { recursive: true });
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFakeOpencode(fakeBin);
  // Law 19 requires two numbered steps before the **Reply:** line; the
  // template's default TODO body has none, so supply a real body.
  const bodyFile = path.join(base, 'body.md');
  writeFileSync(bodyFile, '1. Do the work.\n2. Verify the result.\n');
  const env = { OPENCODE_CONFIG_DIR: cfg, FAKE_OPENCODE_CONFIG: cfg, PATH: fakePath(fakeBin) };
  return {
    base,
    cfg,
    env,
    bodyFile,
    run: (args, input = '') => runCli(args, { env, input, cwd: base }),
    install: () => runCli(['setup'], { env, input: 'y\n', cwd: base }),
  };
}

const allowsOf = (cfg, id) =>
  (parseJsoncForTest(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8')).permissions || [])
    .filter((p) => p.action === 'skill' && p.effect === 'allow' && p.resource === id);
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/* -------------------------------- test 1 ------------------------------ */

test('evolve skill writes the pair and one allow; a repeat needs --force', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run, install } = evolveFixture('oc-evolve-skill-');
  try {
    assert.equal(install().status, 0, 'the baseline install is clean');

    const args = ['evolve', 'skill', 'demo-x', '--title', 'Demo', '--description', 'A demo skill'];
    const r = run(args);
    assert.equal(r.status, 0, `evolve exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.ok(existsSync(path.join(cfg, 'skills', 'demo-x', 'SKILL.md')), 'SKILL.md written');
    assert.ok(existsSync(path.join(cfg, 'commands', 'demo-x.md')), 'command written');
    assert.equal(allowsOf(cfg, 'demo-x').length, 1, 'exactly one allow entry');

    const again = run(args);
    assert.equal(again.status, 1, 'a second run without --force fails');
    assert.ok(String(again.stdout || '').includes('artifact already exists'), 'the refusal is named');
    assert.equal(allowsOf(cfg, 'demo-x').length, 1, 'the refusal changed nothing');

    const forced = run([...args, '--force']);
    assert.equal(forced.status, 0, `forced rerun exit was ${forced.status}\nSTDOUT:\n${forced.stdout}`);
    assert.equal(allowsOf(cfg, 'demo-x').length, 1, '--force does not duplicate the allow');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- test 2 ------------------------------ */

test('evolve playbook adds exactly one router row', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run, install, bodyFile } = evolveFixture('oc-evolve-playbook-');
  try {
    assert.equal(install().status, 0, 'the baseline install is clean');
    const router = path.join(cfg, 'skills', 'playbook', 'SKILL.md');
    const r = run(['evolve', 'playbook', 'demo-y', '--title', 'Demo Y', '--description', 'A demo playbook', '--body', bodyFile]);
    assert.equal(r.status, 0, `evolve exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.ok(existsSync(path.join(cfg, 'playbooks', 'demo-y.md')), 'playbook written');
    const rows = readFileSync(router, 'utf8').split(/\r?\n/)
      .filter((l) => l.includes('playbooks/demo-y.md'));
    assert.equal(rows.length, 1, `exactly one router row (saw ${rows.join(' | ')})`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- test 3 ------------------------------ */

test('invalid kind and id exit 2', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const { base, run } = evolveFixture('oc-evolve-invalid-');
  try {
    const kind = run(['evolve', 'bogus', 'demo']);
    assert.equal(kind.status, 2, `bad kind exit was ${kind.status}\nSTDOUT:\n${kind.stdout}`);
    assert.ok(String(kind.stdout || '').includes('invalid kind'), 'the kind error is named');
    const id = run(['evolve', 'skill', 'Bad_Id', '--title', 'Bad', '--description', 'Bad id']);
    assert.equal(id.status, 2, `bad id exit was ${id.status}\nSTDOUT:\n${id.stdout}`);
    assert.ok(String(id.stdout || '').includes('invalid id'), 'the id error is named');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- test 4 ------------------------------ */

test('--dry-run writes nothing', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run, install } = evolveFixture('oc-evolve-dry-');
  try {
    assert.equal(install().status, 0, 'the baseline install is clean');
    const config = path.join(cfg, 'opencode.jsonc');
    const before = sha(config);
    const r = run(['evolve', 'skill', 'dry-x', '--title', 'Dry', '--description', 'Dry run', '--dry-run']);
    assert.equal(r.status, 0, `dry-run exit was ${r.status}\nSTDOUT:\n${r.stdout}`);
    assert.ok(!existsSync(path.join(cfg, 'skills', 'dry-x')), 'no skill dir');
    assert.ok(!existsSync(path.join(cfg, 'commands', 'dry-x.md')), 'no command');
    assert.equal(sha(config), before, 'the config is byte-identical');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- test 5 ------------------------------ */

test('a setup after evolve still passes', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run, install } = evolveFixture('oc-evolve-setup-');
  try {
    assert.equal(install().status, 0, 'the baseline install is clean');
    assert.equal(run(['evolve', 'skill', 'post-x', '--title', 'Post', '--description', 'Post evolve']).status, 0, 'evolve passed');
    const r = install();
    assert.equal(r.status, 0, `setup after evolve exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.equal(allowsOf(cfg, 'post-x').length, 1, 'the adopter allow survives the setup re-run');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- test 6 ------------------------------ */

test('a full install ships five playbooks and doctor law 19 grades them', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, install } = evolveFixture('oc-evolve-law19-');
  try {
    const r = install();
    assert.equal(r.status, 0, `install exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    const files = readdirSync(path.join(cfg, 'playbooks')).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 5, `exactly five playbooks shipped (saw ${files.join(', ')})`);
    assert.ok(String(r.stdout || '').includes(LAW19), 'law 19 is present in the doctor output');
    const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.includes(LAW19));
    assert.ok(line.includes('5 playbook file(s)'), `law 19 names five files: ${line}`);
    assert.ok(!line.includes('no playbooks shipped'), 'law 19 did not fall back to the empty case');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
