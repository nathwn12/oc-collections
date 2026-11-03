/**
 * Shared helpers for the oc-harness-setup CLI test shards (node:test + node:assert only).
 * Extracted verbatim from test/cli.test.js: constants, runCli, the JSONC
 * strippers, doctor fixtures, walkFiles, the fake opencode shim, and the
 * /goal fixture builders. No test lives here.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WINDOWS = process.platform === 'win32';
export const WIN_SKIP = WINDOWS ? false : 'non-Windows OS — this starter ships Windows 10/11 only; nothing ran';

export const PKG_ROOT = path.resolve(import.meta.dirname, '..');
export const CLI = path.join(PKG_ROOT, 'bin', 'cli.js');
// Derived, never typed: a patch bump used to leave this literal behind and
// fail the suite on every release for no product reason.
export const EXPECTED_VERSION = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
export const EXPECTED_AGENTS = [
  'code-agent', 'git-agent', 'harness-agent', 'host-agent', 'memory-agent',
  'release-agent', 'research-agent', 'secret-agent', 'surface-agent', 'verify-agent',
];
export const EXPECTED_SKILLS = ['close', 'evolve', 'fast', 'loop', 'search', 'swarm'];

export const sha256Text = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

export function runCli(args, { env = {}, input, cwd, nodeArgs = [] } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, CLI, ...args], {
    encoding: 'utf8',
    input,
    cwd,
    env: { ...process.env, ...env },
  });
}

export function stripLineComments(text) {
  return text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
}

/* JSONC parse helper for reading the package's own opencode.jsonc in tests:
 * string-aware // and block comment stripping, then trailing-comma drops. */
export function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

export function dropTrailingCommas(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

export function parseJsoncForTest(text) {
  return JSON.parse(dropTrailingCommas(stripJsonComments(text)));
}

// Minimal config dir satisfying the doctor's Law 1: opencode.jsonc (given),
// AGENTS.md, .gitignore, dirs agents/ commands/ skills/ reference/,
// state/lessons.md + state/template.md (fixed key order), plus one valid
// agent, command, and skill so the frontmatter laws have something to grade.
export function makeDoctorFixture(base, configObject) {
  const cfg = path.join(base, 'cfg');
  for (const d of ['agents', 'commands', 'skills', 'reference', 'state', 'scripts']) {
    mkdirSync(path.join(cfg, d), { recursive: true });
  }
  writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify(configObject, null, 2));
  writeFileSync(path.join(cfg, 'AGENTS.md'), '# test contract\n');
  writeFileSync(path.join(cfg, '.gitignore'), 'state/\n');
  writeFileSync(path.join(cfg, 'state', 'lessons.md'), '# lessons\n');
  writeFileSync(
    path.join(cfg, 'state', 'template.md'),
    ['id: a', 'title: b', 'status: c', 'goal: d', 'next: e', 'artifacts: f', 'decisions: g', 'open: h'].join('\n') + '\n'
  );
  writeFileSync(
    path.join(cfg, 'agents', 'orchestrator.md'),
    ['---', 'description: test orchestrator', 'steps: 40', '---', '# orchestrator', ''].join('\n')
  );
  writeFileSync(
    path.join(cfg, 'commands', 'x.md'),
    ['---', 'description: test command', '---', '# x', ''].join('\n')
  );
  mkdirSync(path.join(cfg, 'skills', 'x'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'skills', 'x', 'SKILL.md'),
    ['---', 'name: x', 'description: test skill', '---', '# x', ''].join('\n')
  );
  // The REAL script copied from the package, so the fixture grades exactly
  // what setup installs.
  writeFileSync(
    path.join(cfg, 'scripts', 'harness-doctor.mjs'),
    readFileSync(path.join(PKG_ROOT, 'scripts', 'harness-doctor.mjs'), 'utf8')
  );
  return cfg;
}

export function runDoctorScript(cfg) {
  const script = path.join(cfg, 'scripts', 'harness-doctor.mjs');
  return spawnSync(process.execPath, [script, '-ConfigDir', cfg], { encoding: 'utf8' });
}

export function runDoctorNode(cfg) {
  const r = runDoctorScript(cfg);
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

export function walkFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}
/* ---------------- fake opencode + hermetic PATH ---------------- */

export function writeFakeOpencode(binDir) {
  const mjs = path.join(binDir, 'fake-opencode.mjs');
  writeFileSync(mjs, `const cfg = process.env.FAKE_OPENCODE_CONFIG ?? '';
export const a = process.argv.slice(2);
export const out = (s) => process.stdout.write(s + '\\n');
if (a[0] === '--version') out(process.env.FAKE_OPENCODE_VERSION ?? 'opencode v2.2.0');
else if (a[0] === 'debug' && a[1] === 'paths') out('config = ' + cfg);
else if (a[0] === 'debug' && a[1] === 'config') out(JSON.stringify([{ type: 'document', path: cfg + '/opencode.jsonc' }]));
else if (a[0] === 'debug' && a[1] === 'agents') out(JSON.stringify([{ id: 'orchestrator', name: 'Orchestrator', mode: 'primary' }]));
else if (a[0] === 'plugin' && a[1] === 'list') {
  // Default: no plugins. When FAKE_OPENCODE_PLUGINS names installed plugins,
  // the registry agrees with the config — otherwise Law 6 (correctly) fails
  // a config that declares plugins the registry does not have.
  const rows = (process.env.FAKE_OPENCODE_PLUGINS ?? '').split(/[,\\s]+/).filter(Boolean);
  if (!rows.length) out('No plugins found');
  // The real v2.2.0 table: ID · VERSION · SOURCE, where SOURCE is the specifier
  // the config declares. Pinned so a doctor that only matched the ID column
  // (or the old 'NAME VERSION' header) goes red here, not on the owner's host.
  else { out('ID                 VERSION  SOURCE'); for (const name of rows) out(name + '  2.2.0  ' + name); }
}
else if (a[0] === 'mcp' && a[1] === 'list') out('No MCP servers configured');
else { process.stderr.write('fake opencode: unknown args ' + a.join(' ') + '\\n'); process.exitCode = 1; }
`);
  writeFileSync(path.join(binDir, 'opencode.cmd'), `@echo off\r\nnode "%~dp0fake-opencode.mjs" %*\r\n`);
}

// PATH with every directory holding a REAL opencode removed, so the fake
// .cmd shim is the only `opencode` the installer can reach. (On Windows a
// real opencode.exe elsewhere on PATH wins the lookup and even creates the
// config dir on `debug paths`, breaking hermetic tests.)
export function fakePath(fakeBin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter((d) => {
    if (!d) return false;
    for (const n of ['opencode.exe', 'opencode.cmd', 'opencode']) {
      try {
        if (statSync(path.join(d, n)).isFile()) return false;
      } catch { /* absent — keep the dir */ }
    }
    return true;
  });
  return `${fakeBin}${path.delimiter}${dirs.join(path.delimiter)}`;
}
export const GOAL_COMMAND_TEXT = '---\ndescription: adopter /goal command\n---\n# /goal\n';
export const GOAL_SKILL_TEXT = '---\nname: goal\ndescription: adopter goal skill\n---\n# goal\n';

export function makeGoalFixture(prefix) {
  const base = mkdtempSync(path.join(os.tmpdir(), prefix));
  const cfg = path.join(base, 'cfg');
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFakeOpencode(fakeBin);
  return {
    base,
    cfg,
    run: ({ env = {}, nodeArgs = [] } = {}) => runCli(['setup'], {
      env: { OPENCODE_CONFIG_DIR: cfg, FAKE_OPENCODE_CONFIG: cfg, PATH: fakePath(fakeBin), ...env },
      input: 'y\n',
      cwd: base,
      nodeArgs,
    }),
  };
}

export function writeGoalPair(cfg, commandText = GOAL_COMMAND_TEXT, skillText = GOAL_SKILL_TEXT) {
  mkdirSync(path.join(cfg, 'commands'), { recursive: true });
  mkdirSync(path.join(cfg, 'skills', 'goal'), { recursive: true });
  writeFileSync(path.join(cfg, 'commands', 'goal.md'), commandText);
  writeFileSync(path.join(cfg, 'skills', 'goal', 'SKILL.md'), skillText);
}

// The adopter allow that may die ONLY on a `skills/goal/...` retirement.
export function writeGoalAllowConfig(cfg) {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    path.join(cfg, 'opencode.jsonc'),
    JSON.stringify({ permissions: [{ action: 'skill', resource: 'goal', effect: 'allow' }] }, null, 2)
  );
}

export function writePriorJournal(cfg, files) {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    path.join(cfg, 'oc-harness-setup.manifest.json'),
    JSON.stringify({
      package: 'oc-harness-setup', version: '0.5.0', created: new Date(0).toISOString(),
      configDir: cfg, files,
    }, null, 2)
  );
}

export const posix = (p) => String(p).replace(/\\/g, '/');
export const permsOf = (cfg) => JSON.parse(stripLineComments(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8'))).permissions || [];
export const journalFor = (cfg, rel) => JSON.parse(readFileSync(path.join(cfg, 'oc-harness-setup.manifest.json'), 'utf8'))
  .files.filter((f) => posix(f.path) === rel);
export const allowsOf = (cfg) => (JSON.parse(stripLineComments(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8'))).permissions || [])
  .filter((p) => p.action === 'skill' && p.effect === 'allow')
  .map((p) => p.resource);
export const legacyArchivedAt = (cfg, ...parts) => path.join(cfg, 'state', 'archive', 'legacy-0.3.x', ...parts);

// Adopter rules beyond the single goal allow: the merge's prune is asked about
// every user rule, so the fixture writes whatever permission list a row needs.
export function writeConfigRules(cfg, permissions) {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify({ permissions }, null, 2));
}

// Deterministic, fixture-local filesystem fault. The child CLI loads this CJS
// shim with --require BEFORE bin/cli.js, and the named fs call refuses exactly
// one path once per process — no ACLs, no host state, no test seam in the
// product. The shim lives inside the row's temp base, so rmSync(base) removes
// it, and every other path in the run reads normally.
export function writeFsFaultInjector(base, { op, target }) {
  const file = path.join(base, 'fs-fault.cjs');
  writeFileSync(file, [
    "const fs = require('node:fs');",
    'const target = process.env.OC_FAULT_PATH;',
    'const op = process.env.OC_FAULT_OP;',
    'const orig = fs[op];',
    'fs[op] = function (p, ...rest) {',
    '  if (String(p) === target) {',
    "    const err = new Error('EACCES: injected ' + op + ' failure');",
    "    err.code = 'EACCES';",
    '    err.syscall = op;',
    '    err.path = String(p);',
    '    throw err;',
    '  }',
    '  return orig.call(this, p, ...rest);',
    '};',
    '',
  ].join('\n'));
  return {
    nodeArgs: ['--require', file],
    env: { OC_FAULT_PATH: target, OC_FAULT_OP: op },
  };
}
