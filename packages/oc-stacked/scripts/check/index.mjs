#!/usr/bin/env node
/**
 * The plugin's own proving check. No OpenCode required, no network, no deps.
 *
 * It answers one question: if a user installed this today, would the thing that
 * loads actually work? Every assertion here is a way the plugin has failed or
 * could fail silently in a host.
 *
 *   node scripts/check.mjs                    the full suite, the documented command
 *   node scripts/check.mjs --list             the subject names
 *   node scripts/check.mjs --only title,close one selection, in this process
 *   node scripts/check.mjs --changed          the subjects a diff against HEAD touches
 *   node scripts/check.mjs --changed main     ... against another ref
 *   node scripts/check.mjs --jobs             the selection in child processes
 *   node scripts/check.mjs --jobs 8 --only gate
 *
 * The runner owns the counters, the coloured lines, the exit code, and the
 * fixtures more than one subject needs. Each subject lives in its own module
 * beside this one and exports `register(ctx)`; this file calls them in order.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolDefinitions } from '../../lib/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const self = fileURLToPath(import.meta.url);

// Loaded on demand: a worker that cannot even load its subject is a failure of
// that subject, not of the runner, and `--list` never pays for the imports.
const SUBJECTS = [
  { name: 'agents', load: () => import('./agents.mjs') },
  { name: 'content', load: () => import('./content.mjs') },
  { name: 'state', load: () => import('./state.mjs') },
  { name: 'exec', load: () => import('./exec.mjs') },
  { name: 'git', load: () => import('./git.mjs') },
  { name: 'tools', load: () => import('./tools.mjs') },
  { name: 'gate', load: () => import('./gate.mjs') },
  { name: 'close', load: () => import('./close.mjs') },
  { name: 'title', load: () => import('./title.mjs') },
  { name: 'router', load: () => import('./router.mjs') },
  { name: 'plugin', load: () => import('./plugin.mjs') },
];
const NAMES = SUBJECTS.map((s) => s.name);
const BY_NAME = new Map(SUBJECTS.map((s) => [s.name, s]));

/**
 * Which sources a subject proves, so `--changed` does not make the caller
 * remember the blast radius. Paths are relative to this package.
 *
 * The derivation is the module's own imports, plus the modules that implement
 * the tool operations it calls, plus the package files it reads with `fs`:
 *   - `tools` also names `lib/text.js`: tool definitions live in `lib/tools.js`,
 *     and the table, slug and stamp helpers the tools render with are in text.
 *   - `gate` also names `lib/checks.js`: it asserts `checkRecordReasons`, which
 *     `lib/tools.js` re-exports from checks.
 *   - `title` names `lib/close.js` because it mints fixtures with `signReceipt`.
 *   - package-wide sweeps (the CEO ghost walk, the provenance walk) are not
 *     edges here: they watch every file, and mapping them would select the whole
 *     suite for any diff. A sweep failure still shows in the full run.
 */
const OWNERS = {
  agents: ['agents/**', 'routing.json', 'skills/stacked-lead/SKILL.md', 'skills/stacked-employee/references/**'],
  content: [
    'lib/content.js',
    'lib/bootstrap.js',
    'skills/**',
    'README.md',
    'OWNER.md',
    'RELEASING.md',
    'commands/**',
    'package.json',
    'scripts/install.mjs',
  ],
  state: ['lib/state.js', 'lib/tools.js'],
  exec: ['lib/exec.js', 'bin/stack.js', 'package.json'],
  git: ['lib/exec.js', 'lib/git.js'],
  tools: ['lib/tools.js', 'lib/text.js'],
  gate: ['lib/tools.js', 'lib/checks.js'],
  close: ['lib/close.js', 'lib/git.js'],
  title: ['index.js', 'lib/title.js', 'lib/close.js', 'lib/git.js'],
  router: ['lib/router.js', 'index.js', 'roles/**'],
  // The vanilla cases drive the real setup and read what it installs: the
  // catalogue in `agents/` and `roles/`, the skills it registers, and the router
  // that answers the first prompt.
  plugin: ['index.js', 'lib/content.js', 'lib/router.js', 'roles/**', 'agents/**', 'skills/**', 'SOUL.md'],
};
/** A change to the runner changes how every subject is proven. */
const EVERY = ['scripts/check/index.mjs'];
/** A subject proves its own module. */
const OWN_MODULE = /^scripts\/check\/([a-z]+)\.mjs$/;

const DEADLINE_MS = 120_000;
const DEFAULT_JOBS = Math.max(1, Math.min(4, os.cpus().length || 1));

class UsageError extends Error {}
const USAGE =
  'usage: node scripts/check.mjs [--list] [--only <names>] [--changed [<ref>]] [--jobs [<n>]]';

const messageOf = (err) => String(err && err.message !== undefined ? err.message : err);

// ------------------------------------------------------------------ fixtures

/**
 * Every fixture is a copy of one repository built once per process.
 *
 * Measured on this machine (Windows, 2026-11-11, 20 iterations): a fixture made
 * by `git init`, two `git config` and one `git commit` costs 390 ms - five
 * process spawns for one empty repository; a recursive copy of that same
 * directory costs 20 ms and leaves the same HEAD, the same `.git/config` and a
 * clean tree. Nothing a subject can observe changes - only where the bytes come
 * from.
 *
 * Two templates, because the two fixtures are not the same repository:
 * `tmpRepo()` has always been an initialised repo with *no commit yet*, and its
 * callers can tell (a gate that refuses on a missing HEAD, a `check init` that
 * must find no config). `configuredRepo()` has one commit holding
 * `.stack/config.json`. Both are built lazily, at most once per process.
 */
const DEFAULT_COMMAND = 'node -e "process.exit(0)"';
const templates = [];

/** A directory the runner owns and sweeps on exit; never a fixture. */
function templateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-template-'));
  templates.push(dir);
  if (templates.length === 1) {
    // The fixtures are swept by the subjects that make them. The template is the
    // runner's own, so the runner sweeps it the same way on the way out - and a
    // delete that fails must not turn a green suite red, so tmp keeps the rest.
    process.on('exit', () => {
      for (const leaked of templates) {
        try {
          fs.rmSync(leaked, { recursive: true, force: true });
        } catch {
          // The OS reclaims tmp; nothing here is worth an exit code.
        }
      }
    });
  }
  return dir;
}

const fixtureDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-'));

function copyTemplate(template, dir) {
  fs.cpSync(template, dir, { recursive: true });
  return dir;
}

function commitAllIn(dir, message) {
  spawnSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
  spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', message], {
    cwd: dir,
    windowsHide: true,
  });
}

const checkConfig = (command) =>
  JSON.stringify({ checks: [{ name: 'ok', command, timeout: 60000 }] }, null, 2);

let plainTemplate = null;
let seededTemplate = null;

/** The repo `tmpRepo()` has always returned: identity configured, no commit. */
function plainRepo() {
  if (!plainTemplate) {
    const dir = templateDir();
    spawnSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    spawnSync('git', ['config', 'user.email', 'check@local'], { cwd: dir, windowsHide: true });
    spawnSync('git', ['config', 'user.name', 'check'], { cwd: dir, windowsHide: true });
    plainTemplate = dir;
  }
  return plainTemplate;
}

/** The plain repo plus one committed, passing check: the gate fixture. */
function seededRepo() {
  if (!seededTemplate) {
    const dir = copyTemplate(plainRepo(), templateDir());
    fs.mkdirSync(path.join(dir, '.stack'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.stack', 'config.json'), checkConfig(DEFAULT_COMMAND));
    commitAllIn(dir, 'seed config');
    seededTemplate = dir;
  }
  return seededTemplate;
}

/**
 * The ctx every subject receives, and the tally it wrote. A sink buffers the
 * lines instead of printing them: a worker hands its block to the parent, which
 * prints the blocks in module order.
 */
function context(sink) {
  const state = { pass: 0, failures: [] };
  const line = (text) => (sink ? sink.push(text) : process.stdout.write(text));

  function check(name, fn) {
    try {
      const detail = fn();
      state.pass += 1;
      line(`  pass  ${name}${detail ? `  (${detail})` : ''}\n`);
    } catch (err) {
      const message = messageOf(err);
      state.failures.push({ name, message });
      line(`  FAIL  ${name}\n        ${message}\n`);
    }
  }

  async function checkAsync(name, fn) {
    try {
      const detail = await fn();
      state.pass += 1;
      line(`  pass  ${name}${detail ? `  (${detail})` : ''}\n`);
    } catch (err) {
      const message = messageOf(err);
      state.failures.push({ name, message });
      line(`  FAIL  ${name}\n        ${message}\n`);
    }
  }

  const assert = (cond, message) => {
    if (!cond) throw new Error(message);
  };

  function tmpRepo() {
    return copyTemplate(plainRepo(), fixtureDir());
  }

  function commitAll(dir, message) {
    commitAllIn(dir, message);
  }

  /**
   * A repo with one committed, passing check: the fixture every gate test needs.
   * A caller that varies the command gets the committed config rewritten and
   * amended onto the one commit, so the tree is still clean at the same HEAD
   * shape as before - one spawn instead of building the repository again.
   */
  function configuredRepo(command = DEFAULT_COMMAND) {
    const dir = copyTemplate(seededRepo(), fixtureDir());
    if (command !== DEFAULT_COMMAND) {
      fs.writeFileSync(path.join(dir, '.stack', 'config.json'), checkConfig(command));
      spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qa', '--amend', '--no-edit'], {
        cwd: dir,
        windowsHide: true,
      });
    }
    return dir;
  }

  /** Run one tool against a repository other than the caller's own fixture. */
  async function runIn(otherDir, name, input) {
    const def = toolDefinitions({ dir: otherDir }).find((t) => t.name === name);
    const result = await def.execute(input, {});
    const content = typeof result === 'string' ? result : result?.content;
    assert(typeof content === 'string' && content.length, `${name} returned no content in ${otherDir}`);
    return content;
  }

  return {
    state,
    ctx: { check, checkAsync, assert, repo, tmpRepo, commitAll, configuredRepo, runIn },
  };
}

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = { list: false, only: [], changed: null, jobs: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);

    if (flag === '--list') {
      if (inline !== null) throw new UsageError(`--list takes no value\n${USAGE}`);
      args.list = true;
    } else if (flag === '--only') {
      let value = inline;
      if (value === null) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError(`--only needs a comma-separated list of subjects\n${USAGE}`);
        }
        i += 1;
      }
      const picked = [];
      for (const part of String(value).split(',')) {
        const name = part.trim();
        if (!name) continue;
        if (!BY_NAME.has(name)) {
          throw new UsageError(`unknown subject: ${name}\nvalid subjects: ${NAMES.join(', ')}`);
        }
        if (!picked.includes(name)) picked.push(name);
      }
      if (!picked.length) {
        throw new UsageError(`--only needs at least one subject\nvalid subjects: ${NAMES.join(', ')}`);
      }
      args.only = picked;
    } else if (flag === '--changed') {
      if (inline !== null) {
        args.changed = inline || 'HEAD';
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          args.changed = next;
          i += 1;
        } else {
          args.changed = 'HEAD';
        }
      }
    } else if (flag === '--jobs') {
      let value = inline;
      if (value === null) {
        const next = argv[i + 1];
        if (next !== undefined && /^\d+$/.test(next)) {
          value = next;
          i += 1;
        } else if (next !== undefined && !next.startsWith('--')) {
          throw new UsageError(`--jobs needs a whole number, not ${next}\n${USAGE}`);
        }
      }
      const jobs = value === null || value === undefined ? DEFAULT_JOBS : Number(value);
      if (!Number.isInteger(jobs) || jobs < 1) {
        throw new UsageError(`--jobs needs a whole number of at least 1\n${USAGE}`);
      }
      args.jobs = jobs;
    } else {
      throw new UsageError(`unknown argument: ${raw}\n${USAGE}`);
    }
  }
  return args;
}

// ------------------------------------------------------------ changed paths

function gitOut(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error) return { error: r.error.message };
  if (r.status !== 0) return { error: (r.stderr || '').trim() || `exit ${r.status}` };
  return { text: r.stdout || '' };
}

function matches(pattern, rel) {
  if (pattern.endsWith('/**')) {
    const base = pattern.slice(0, -3);
    return rel === base || rel.startsWith(`${base}/`);
  }
  return rel.toLowerCase() === pattern.toLowerCase();
}

/** The path inside this package, or null when the change is outside it. */
function packageRelative(changed, prefix) {
  const p = changed.replace(/\\/g, '/');
  if (!prefix) return p;
  if (p === prefix) return '';
  return p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : null;
}

function coveredBy(rel) {
  const names = [];
  for (const [name, patterns] of Object.entries(OWNERS)) {
    if (patterns.some((pattern) => matches(pattern, rel))) names.push(name);
  }
  let extras = [];
  if (EVERY.some((pattern) => matches(pattern, rel))) {
    extras = NAMES;
  } else {
    const own = OWN_MODULE.exec(rel);
    if (own && BY_NAME.has(own[1])) extras = [own[1]];
  }
  for (const name of extras) if (!names.includes(name)) names.push(name);
  return names;
}

/**
 * The subjects a diff against `ref` touches: tracked changes against the ref
 * plus untracked files, mapped through OWNERS. Paths outside this package are
 * reported as uncovered rather than guessed at.
 */
function subjectsForChange(ref) {
  const nothing = (error) => ({ error, names: [], reasons: new Map(), all: [], uncovered: [] });

  const top = gitOut(['rev-parse', '--show-toplevel'], repo);
  if (top.error) return nothing(`--changed needs a git repository: ${top.error}`);
  const root = top.text.trim();

  const diff = gitOut(['diff', '--name-only', ref], root);
  if (diff.error) return nothing(`--changed could not diff against ${ref}: ${diff.error}`);
  const untracked = gitOut(['ls-files', '--others', '--exclude-standard'], root);
  if (untracked.error) return nothing(`--changed could not list untracked files: ${untracked.error}`);

  const all = [];
  for (const line of `${diff.text}\n${untracked.text}`.split('\n')) {
    const p = line.trim();
    if (p && !all.includes(p)) all.push(p);
  }

  const prefix = path.relative(root, repo).replace(/\\/g, '/');
  const names = [];
  const reasons = new Map();
  const uncovered = [];
  for (const changed of all) {
    const rel = packageRelative(changed, prefix);
    if (rel === null) {
      uncovered.push(changed);
      continue;
    }
    const hit = coveredBy(rel);
    if (!hit.length) {
      uncovered.push(changed);
      continue;
    }
    for (const name of hit) {
      if (!names.includes(name)) {
        names.push(name);
        reasons.set(name, changed);
      }
    }
  }
  names.sort((a, b) => NAMES.indexOf(a) - NAMES.indexOf(b));
  return { names, reasons, all, uncovered };
}

// ---------------------------------------------------------------- workers

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone: the close event says how.
  }
}

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim().slice(0, 300);

function crashed(subject, out, why) {
  const partial = out ? (out.endsWith('\n') ? out : `${out}\n`) : '';
  return {
    name: subject,
    block: `${partial}  FAIL  ${subject} worker reported no result\n        ${oneLine(why)}\n`,
    pass: 0,
    failures: [{ name: `${subject} worker`, message: oneLine(why) }],
  };
}

function parseWorkerResult(subject, out) {
  const text = out.replace(/\s+$/, '');
  if (!text) return null;
  const at = text.lastIndexOf('\n');
  const last = at === -1 ? text : text.slice(at + 1);
  let json;
  try {
    json = JSON.parse(last);
  } catch {
    return null;
  }
  if (!json || json.subject !== subject || typeof json.pass !== 'number' || !Array.isArray(json.failures)) {
    return null;
  }
  return {
    name: subject,
    block: at === -1 ? '' : text.slice(0, at + 1),
    pass: json.pass,
    failures: json.failures.map((f) => ({
      name: String(f?.name ?? subject),
      message: String(f?.message ?? ''),
    })),
  };
}

function runWorker(subject) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let timer = null;
    let timedOut = false;
    let out = '';
    let err = '';

    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(process.execPath, [self, '--worker', subject], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      // The tree is told to die; if it will not, the suite still ends.
      setTimeout(() => done(crashed(subject, out, `no result ${DEADLINE_MS / 1000}s after the deadline`)), 5000);
    }, DEADLINE_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', (e) => done(crashed(subject, out, `could not start: ${e.message}`)));
    child.on('close', (code, signal) => {
      if (timedOut) {
        done(crashed(subject, out, `killed after ${DEADLINE_MS / 1000}s`));
        return;
      }
      const parsed = parseWorkerResult(subject, out);
      if (parsed) {
        done(parsed);
        return;
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const why = `exited ${code ?? signal} after ${seconds}s${err ? `: ${err}` : ''}`;
      done(crashed(subject, out, why));
    });
  });
}

async function runPool(names, jobs) {
  const results = new Array(names.length);
  const lanes = Math.max(1, Math.min(jobs, names.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= names.length) return;
        results[i] = await runWorker(names[i]);
      }
    }),
  );
  return results;
}

/** The child half: exactly one subject, its block and its tally as JSON. */
async function runWorkerSubject(subject) {
  const lines = [];
  const { state, ctx } = context(lines);
  const finish = () => {
    const result = { subject, pass: state.pass, failures: state.failures };
    process.stdout.write(`${lines.join('')}${JSON.stringify(result)}\n`);
  };
  try {
    const { register } = await BY_NAME.get(subject).load();
    await register(ctx);
  } catch (err) {
    const message = messageOf(err);
    state.failures.push({ name: `${subject} crashed`, message });
    lines.push(`  FAIL  ${subject} crashed\n        ${message.split('\n')[0]}\n`);
  }
  finish();
}

// ------------------------------------------------------------------- main

function printSelection(names, reasons, ref) {
  const label = names.length === 1 ? 'subject' : 'subjects';
  process.stdout.write(`selected ${names.length} ${label}${ref ? ` for --changed ${ref}` : ''}\n`);
  for (const name of names) process.stdout.write(`  ${name.padEnd(8)} ${reasons.get(name)}\n`);
  process.stdout.write('\n');
}

function uncoveredWarning(paths) {
  const shown = paths.slice(0, 6);
  const more = paths.length - shown.length;
  return `  warning: no subject asserts ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}\n`;
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.list) {
    process.stdout.write(`${NAMES.join('\n')}\n`);
    return 0;
  }

  for (const name of Object.keys(OWNERS)) {
    if (!BY_NAME.has(name)) throw new UsageError(`the subject map names an unknown subject: ${name}`);
  }

  let names = NAMES;
  let reasons = null;
  let ref = '';

  if (args.only.length) {
    // An explicit selection is an override: it wins over --changed.
    names = args.only;
    reasons = new Map(names.map((name) => [name, 'explicit (--only)']));
  } else if (args.changed) {
    const pick = subjectsForChange(args.changed);
    if (pick.error) throw new UsageError(pick.error);
    if (!pick.names.length) {
      process.stdout.write('\noc-stacked self-test\n\n');
      if (!pick.all.length) {
        process.stdout.write(`no changed paths against ${args.changed}\n\n`);
      } else {
        process.stdout.write(`no subject covers the changed paths\n${uncoveredWarning(pick.uncovered)}\n`);
      }
      return 0;
    }
    names = pick.names;
    reasons = pick.reasons;
    ref = args.changed;
  }

  process.stdout.write('\noc-stacked self-test\n\n');
  if (reasons) printSelection(names, reasons, ref);

  let pass = 0;
  const failures = [];

  if (args.jobs) {
    const results = await runPool(names, args.jobs);
    for (const result of results) {
      process.stdout.write(result.block);
      pass += result.pass;
      failures.push(...result.failures);
    }
  } else {
    const { state, ctx } = context(null);
    for (const name of names) {
      const { register } = await BY_NAME.get(name).load();
      await register(ctx);
    }
    pass = state.pass;
    failures.push(...state.failures);
  }

  const total = pass + failures.length;
  process.stdout.write(`\n${pass}/${total} passed\n\n`);
  if (failures.length) {
    process.stdout.write('Failed:\n');
    for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.message}\n`);
    return 1;
  }
  process.stdout.write('The plugin does what it says. Install it, then restart OpenCode.\n\n');
  return 0;
}

const argv = process.argv.slice(2);
const workerAt = argv.indexOf('--worker');
if (workerAt !== -1) {
  const subject = argv[workerAt + 1];
  if (!BY_NAME.has(subject)) {
    process.stderr.write(`check worker: unknown subject: ${subject}\n`);
    process.exitCode = 2;
  } else {
    await runWorkerSubject(subject);
  }
} else {
  try {
    process.exitCode = await main(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`check: ${err.message}\n`);
      process.exitCode = 2;
    } else {
      throw err;
    }
  }
}
