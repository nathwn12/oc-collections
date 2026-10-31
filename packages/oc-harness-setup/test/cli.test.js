/**
 * oc-harness-setup packaging-lane tests. node:test + node:assert only.
 * Windows 10/11 only: every test skips with a clear message on another OS.
 *
 * Covers: --version, --dry-run manifest, full upgrade install against a
 * fake `opencode` on PATH (prior 0.3.3 manifest retired AND archived, stock
 * AGENTS.md replaced, adopter model/plugins kept, stale skill allows pruned,
 * no distro plugins), negative doctor, doctor no-permissions crash guard (T1),
 * doctor secret-pointer law (T2 literal vs pointer), uninstall restore, and a
 * shipped-content audit (layout counts, 1:1 seam, generic leak scan, T4
 * packaging paths + unwired-routing record).
 * Doctor tests run the shipped Node doctor (scripts/harness-doctor.mjs); they
 * no longer need an interpreter on PATH beyond the Node running the suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WINDOWS = process.platform === 'win32';
const WIN_SKIP = WINDOWS ? false : 'non-Windows OS — this starter ships Windows 10/11 only; nothing ran';

const PKG_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(PKG_ROOT, 'bin', 'cli.js');
// Derived, never typed: a patch bump used to leave this literal behind and
// fail the suite on every release for no product reason.
const EXPECTED_VERSION = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
const EXPECTED_AGENTS = [
  'code-agent', 'git-agent', 'harness-agent', 'host-agent', 'memory-agent',
  'release-agent', 'research-agent', 'secret-agent', 'surface-agent', 'verify-agent',
];
const EXPECTED_SKILLS = ['close', 'evolve', 'fast', 'loop', 'search', 'swarm'];

const sha256Text = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function runCli(args, { env = {}, input, cwd, nodeArgs = [] } = {}) {
  return spawnSync(process.execPath, [...nodeArgs, CLI, ...args], {
    encoding: 'utf8',
    input,
    cwd,
    env: { ...process.env, ...env },
  });
}

function stripLineComments(text) {
  return text.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
}

/* JSONC parse helper for reading the package's own opencode.jsonc in tests:
 * string-aware // and block comment stripping, then trailing-comma drops. */
function stripJsonComments(text) {
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

function dropTrailingCommas(text) {
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

function parseJsoncForTest(text) {
  return JSON.parse(dropTrailingCommas(stripJsonComments(text)));
}

// Minimal config dir satisfying the doctor's Law 1: opencode.jsonc (given),
// AGENTS.md, .gitignore, dirs agents/ commands/ skills/ reference/,
// state/lessons.md + state/template.md (fixed key order), plus one valid
// agent, command, and skill so the frontmatter laws have something to grade.
function makeDoctorFixture(base, configObject) {
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

function runDoctorScript(cfg) {
  const script = path.join(cfg, 'scripts', 'harness-doctor.mjs');
  return spawnSync(process.execPath, [script, '-ConfigDir', cfg], { encoding: 'utf8' });
}

function runDoctorNode(cfg) {
  const r = runDoctorScript(cfg);
  return { status: r.status, out: `${r.stdout || ''}\n${r.stderr || ''}` };
}

function walkFiles(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/* ---------------- test 1: --version ---------------- */

test(`--version prints ${EXPECTED_VERSION}`, { skip: WIN_SKIP }, () => {
  const r = runCli(['--version']);
  assert.equal(r.status, 0, `exit was ${r.status}: ${r.stderr}`);
  assert.equal((r.stdout || '').trim(), EXPECTED_VERSION);
});

test('startup guard fails clearly on Node <22 (faked process.versions)', { skip: WIN_SKIP }, () => {
  const cliUrl = pathToFileURL(CLI).href;
  const probe = [
    `Object.defineProperty(process.versions, 'node', { value: '18.0.0', configurable: true });`,
    `await import(${JSON.stringify(cliUrl)});`,
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' });
  assert.equal(r.status, 1, `exit was ${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(
    (r.stderr || '').includes('requires Node.js 22'),
    `stderr names the Node 22 floor: ${r.stderr}`
  );
});

/* ---------------- fake opencode + hermetic PATH ---------------- */

function writeFakeOpencode(binDir) {
  const mjs = path.join(binDir, 'fake-opencode.mjs');
  writeFileSync(mjs, `const cfg = process.env.FAKE_OPENCODE_CONFIG ?? '';
const a = process.argv.slice(2);
const out = (s) => process.stdout.write(s + '\\n');
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
function fakePath(fakeBin) {
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

/* ---------------- preflight: the 2.2.0 banner, the gate, and its contract ---------------- */

// The gate has three tiers and one documented contract. This test pins EVERY
// branch plus the documents that describe them, so flipping the code without
// updating the docs (or the reverse) goes red here:
//   1.x        refused before any discovery/stage/merge (different dialect)
//   2.0 / 2.1  warned, then installs (same V2 generation; the deny gate is
//              unproven there, not silently reconfigured)
//   2.2.0      clean, no warning
test('version gate: 1.x refused, 2.0/2.1 warn and install, 2.2.0 clean — docs agree', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-gate-'));
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFakeOpencode(fakeBin);
  const envFor = (cfg, version) => ({
    OPENCODE_CONFIG_DIR: cfg,
    FAKE_OPENCODE_CONFIG: cfg,
    FAKE_OPENCODE_VERSION: version,
    PATH: fakePath(fakeBin),
  });

  try {
    // 1.x: bail before discovery, stage, or merge — nothing a 1.x host cannot
    // honour is ever written.
    const cfg1 = path.join(base, 'cfg-1x');
    const r1 = runCli(['setup'], { env: envFor(cfg1, 'opencode v1.4.2'), input: 'y\n' });
    assert.equal(r1.status, 1, `1.x host must abort, got ${r1.status}\nSTDOUT:\n${r1.stdout}\nSTDERR:\n${r1.stderr}`);
    assert.match(r1.stderr || '', /1\.x config dialect/, 'the refusal names the dialect break');
    assert.ok(!existsSync(cfg1), 'a 1.x host writes nothing');

    // 2.0 and 2.1: warned, not refused (declined gate: warn prints, nothing written).
    for (const version of ['opencode v2.0.9', 'opencode v2.1.4']) {
      const cfg = path.join(base, `cfg-${version.replace(/[^\d]/g, '')}`);
      const r = runCli(['setup'], { env: envFor(cfg, version), input: '' });
      assert.equal(r.status, 0, `${version} must warn and proceed, got ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
      assert.match(`${r.stdout}${r.stderr}`, /below the 2\.2\.0/, `${version} is warned, not refused`);
      assert.match(`${r.stdout}${r.stderr}`, /not proven/, 'the warning names what is unproven on an older 2.x host');
      assert.ok(!existsSync(cfg), 'a declined gate writes nothing');
    }

    // 2.1 actually installs: the warning is a caution, not a block, and the
    // manifest records the host the merge targeted.
    const cfg21 = path.join(base, 'cfg-install');
    const r21 = runCli(['setup'], { env: envFor(cfg21, 'opencode v2.1.4'), input: 'y\n' });
    assert.equal(r21.status, 0, `2.1.4 install exit was ${r21.status}\nSTDOUT:\n${r21.stdout}\nSTDERR:\n${r21.stderr}`);
    assert.match(`${r21.stdout}${r21.stderr}`, /below the 2\.2\.0/);
    const m21 = JSON.parse(readFileSync(path.join(cfg21, 'oc-harness-setup.manifest.json'), 'utf8'));
    assert.equal(m21.hostVersion, '2.1.4', 'the install proceeded and journaled the host version');

    // 2.2.0: clean run, banner parsed once, no warning.
    const cfg22 = path.join(base, 'cfg-22');
    const r22 = runCli(['setup'], { env: envFor(cfg22, 'opencode v2.2.0'), input: '' });
    assert.equal(r22.status, 0, `2.2.0 declined gate exit was ${r22.status}\nSTDOUT:\n${r22.stdout}\nSTDERR:\n${r22.stderr}`);
    assert.ok(!/below the 2\.2\.0|older than the 2\.2\.0/.test(`${r22.stdout}${r22.stderr}`), '2.2.0 is not warned');
    assert.ok((r22.stdout || '').includes('opencode 2.2.0 — OK'), 'the banner version is parsed out of `opencode v2.2.0`');
    assert.ok(!(r22.stdout || '').includes('opencode opencode'), 'the product name is not echoed twice');

    // The documented contract must state all three tiers, in the same terms the
    // code implements. A gate flip that leaves a doc behind fails here. Prose is
    // flattened first: a wrapped line is formatting, not a different contract.
    const flat = (s) => s.replace(/\s+/g, ' ');
    for (const doc of ['README.md', 'docs/GUIDE.md']) {
      const text = flat(readFileSync(path.join(PKG_ROOT, doc), 'utf8'));
      assert.match(text, /2\.2\.0/, `${doc} names the tested floor`);
      assert.match(text, /2\.0\/2\.1[^.]*warn/i, `${doc} states that a 2.0/2.1 host warns`);
      assert.match(text, /1\.x[^.]*refus/i, `${doc} states that a 1.x host is refused`);
    }
    const changelog = flat(readFileSync(path.join(PKG_ROOT, 'CHANGELOG.md'), 'utf8'));
    assert.match(changelog, /2\.2\.0 tested; 2\.x warned; 1\.x refused/i, 'CHANGELOG states the three-tier compatibility truth');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- test 2: --dry-run ---------------- */

test('--dry-run prints the manifest with orchestrator, state/, 18 and creates no files', { skip: WIN_SKIP }, () => {
  // Hermetic fake opencode: the real CLI creates its config dir on `debug
  // paths`, which would break the creates-nothing assertion. The fake only
  // prints, so any created file is the installer's fault.
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-dry-'));
  const cfgDir = path.join(base, 'config');
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFakeOpencode(fakeBin);
  assert.ok(!existsSync(cfgDir));
  const r = runCli(['--dry-run'], {
    env: {
      OPENCODE_CONFIG_DIR: cfgDir,
      FAKE_OPENCODE_CONFIG: cfgDir,
      PATH: fakePath(fakeBin),
    },
  });
  assert.equal(r.status, 0, `exit was ${r.status}: ${r.stderr}`);
  const out = r.stdout || '';
  assert.ok(out.includes('orchestrator'), 'manifest mentions orchestrator');
  assert.ok(out.includes('state/'), 'manifest mentions state/');
  assert.ok(out.includes('18 laws'), 'manifest names the 18-law doctor gate');
  assert.ok(!existsSync(cfgDir), 'dry-run created no files');
});

/* ---------------- test 3: full upgrade install ---------------- */

const shared = {};

test('real install upgrades a prior 0.3.3 tree (fake opencode, real doctor)', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-install-'));
  const cfg = path.join(base, 'cfg');
  mkdirSync(cfg, { recursive: true });
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFakeOpencode(fakeBin);

  // Prior tree: stale 0.3.3 pack files, a STOCK AGENTS.md (hash matches), and
  // the 0.5.0 custom `/goal` command + skill that the rename retires.
  const oldAgents = '# old AGENTS contract\n';
  const oldSkill = '---\nname: old\ndescription: old skill\n---\n';
  const editedX = '---\nname: edited\ndescription: edited skill v1\n---\n';
  const editedY = '---\nname: edited\ndescription: edited skill v2, adopter-modified\n---\n';
  const priorAgent = '# old verify agent v1\n';
  // Adopter-edited but still a legal agent (description+steps), so the doctor
  // grades the harness rather than this fixture's own file.
  const userAgent = '---\ndescription: my own verifier\nsteps: 12\n---\n# my verifier, adopter-modified\n';
  const priorTree = {
    'agents/build.md': '# old build agent\n',
    'agents/verify-agent.md': userAgent, // on disk: user-edited (differs from manifest hash)
    'commands/build.md': '# old build command\n',
    'commands/goal.md': '# old custom /goal command\n',
    'skills/goal/SKILL.md': '---\nname: goal\ndescription: old goal skill\n---\n',
    'skills/old/SKILL.md': oldSkill,
    'skills/edited/SKILL.md': editedY, // on disk: adopter-modified (differs from manifest hash X)
    'reference/old.md': '# old reference\n',
    'scripts/old.ps1': '# old script\n',
    'AGENTS.md': oldAgents,
  };
  const priorFiles = [];
  for (const [rel, text] of Object.entries(priorTree)) {
    const p = path.join(cfg, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
    // The edited skill journals hash X while the disk holds Y; the edited
    // agent journals the prior installed bytes while the disk holds the user's.
    const hash = rel === 'skills/edited/SKILL.md' ? sha256Text(editedX)
      : rel === 'agents/verify-agent.md' ? sha256Text(priorAgent)
      : sha256Text(text);
    // Prior manifests may spell paths with either separator; pin forward slashes here.
    priorFiles.push({ path: rel.split(path.sep).join('/'), hash, action: 'written' });
  }
  writeFileSync(path.join(cfg, 'oc-harness-setup.manifest.json'), JSON.stringify({
    package: 'oc-harness-setup', version: '0.3.3', created: new Date().toISOString(),
    configDir: cfg, files: priorFiles,
  }, null, 2));

  // Adopter config: model + plugins keys the merge must keep, plus a stale
  // `skill old allow` (pruned with its skill) and a custom shell rule (kept).
  const adopterConfig = {
    model: 'keeper-model',
    plugins: ['oc-flight-deck', 'adopter-plugin'],
    permissions: [
      { action: 'skill', resource: 'old', effect: 'allow' },
      { action: 'skill', resource: 'edited', effect: 'allow' },
      { action: 'shell', resource: 'git status *', effect: 'allow' },
    ],
  };
  writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify(adopterConfig, null, 2));

  const env = {
    OPENCODE_CONFIG_DIR: cfg,
    FAKE_OPENCODE_CONFIG: cfg,
    // The preserved adopter plugin must resolve in the fake registry or Law 6
    // (correctly) fails the install — same as a real adopter plugin installed
    // in the real registry.
    FAKE_OPENCODE_PLUGINS: 'adopter-plugin',
    PATH: fakePath(fakeBin),
  };
  const r = runCli(['setup'], { env, input: 'y\n', cwd: cfg });
  assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);

  // The shipped agent roster lands; a freshly copied agent is the pack bytes.
  const agentIds = readdirSync(path.join(cfg, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.deepEqual([...agentIds].sort(), [...EXPECTED_AGENTS].sort(), `${EXPECTED_AGENTS.length} agents installed`);
  const freshAgent = readFileSync(path.join(cfg, 'agents', 'code-agent.md'), 'utf8');
  assert.equal(freshAgent, readFileSync(path.join(PKG_ROOT, 'agents', 'code-agent.md'), 'utf8'), 'a fresh agent carries the shipped bytes');
  assert.ok(!/^model:/m.test(freshAgent), 'a shipped agent carries no model: line');

  // 6 skills + 6 commands land, 12 refs, state files, GLOSSARY.
  const skillDirs = readdirSync(path.join(cfg, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_shared')
    .map((e) => e.name);
  assert.deepEqual([...skillDirs].sort(), [...EXPECTED_SKILLS].sort(), '6 skills installed');
  const commandIds = readdirSync(path.join(cfg, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.deepEqual([...commandIds].sort(), [...EXPECTED_SKILLS].sort(), '6 commands installed');
  assert.ok(existsSync(path.join(cfg, 'commands', 'loop.md')), 'commands/loop.md installed');
  assert.ok(!existsSync(path.join(cfg, 'commands', 'goal.md')), 'the prior custom /goal command was retired');
  const refIds = readdirSync(path.join(cfg, 'reference')).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.slice(0, -3));
  assert.equal(refIds.length, 12, `12 references installed (saw ${refIds.length})`);
  assert.ok(existsSync(path.join(cfg, 'state', 'template.md')), 'state/template.md installed');
  assert.ok(existsSync(path.join(cfg, 'state', 'lessons.md')), 'state/lessons.md installed');
  assert.ok(existsSync(path.join(cfg, 'GLOSSARY.md')), 'GLOSSARY.md installed');

  // Stale 0.3.3 files are retired (bytes matched the prior manifest).
  for (const rel of ['agents/build.md', 'commands/build.md', 'skills/old/SKILL.md', 'reference/old.md', 'scripts/old.ps1']) {
    assert.ok(!existsSync(path.join(cfg, rel)), `${rel} retired`);
  }

  // Modified prior file is archived with the adopter's bytes, active path gone.
  assert.ok(!existsSync(path.join(cfg, 'skills', 'edited', 'SKILL.md')), 'edited active path is gone');
  const archived = path.join(cfg, 'state', 'archive', 'legacy-0.3.x', 'skills', 'edited', 'SKILL.md');
  assert.ok(existsSync(archived), 'edited skill archived under state/archive/legacy-0.3.x/');
  assert.equal(readFileSync(archived, 'utf8'), editedY, 'archive holds the adopter-modified bytes');

  // Stock AGENTS.md (prior hash matched) is replaced by the current contract.
  const agents = readFileSync(path.join(cfg, 'AGENTS.md'), 'utf8');
  assert.ok(!agents.includes('old AGENTS'), 'old AGENTS.md bytes are gone');

  // Adopter-edited incoming file: their bytes stay untouched and the new
  // version lands beside the file as `.new` — never archived, never replaced.
  const publicAgent = readFileSync(path.join(PKG_ROOT, 'agents', 'verify-agent.md'), 'utf8');
  assert.equal(readFileSync(path.join(cfg, 'agents', 'verify-agent.md'), 'utf8'), userAgent, 'the adopter-edited agent is byte-identical');
  assert.equal(readFileSync(path.join(cfg, 'agents', 'verify-agent.md.new'), 'utf8'), publicAgent, 'the new agent version landed beside it as .new');
  assert.ok(!existsSync(path.join(cfg, 'state', 'archive', 'legacy-0.3.x', 'agents', 'verify-agent.md')), 'a kept file is never archived');
  assert.match(r.stdout || '', /kept user file agents\/verify-agent\.md, wrote agents\/verify-agent\.md\.new/, 'the keep is reported with the .new path');

  // Merged opencode.jsonc: adopter keys kept, stale skill allows pruned, distro policy wins.
  const merged = JSON.parse(stripLineComments(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8')));
  assert.equal(merged.model, 'keeper-model', 'adopter model kept');
  assert.ok((merged.plugins || []).includes('adopter-plugin'), 'adopter plugin kept');
  assert.ok(!(merged.plugins || []).includes('oc-flight-deck'), 'no distro plugin in the merge');
  assert.deepEqual(merged.plugins, ['adopter-plugin'], '0.3.x distro plugin dropped, adopter plugin kept');
  assert.equal(merged.default_agent, 'orchestrator', 'default_agent is orchestrator');
  const allows = (merged.permissions || []).filter((p) => p.action === 'skill' && p.effect === 'allow').map((p) => p.resource);
  assert.deepEqual([...allows].sort(), [...EXPECTED_SKILLS].sort(), 'exactly the 6 skill allows (stale old/edited pruned)');
  const custom = (merged.permissions || []).filter((p) => p.action === 'shell' && p.resource === 'git status *');
  assert.equal(custom.length, 1, 'custom adopter shell rule kept');
  assert.ok(Array.isArray(merged.policies) && merged.policies.length === 6, 'policies block present with 6 entries');
  for (const p of merged.policies) {
    assert.equal(p.action, 'tool.use', 'every policy entry uses action tool.use');
    assert.ok(typeof p.resource === 'string' && p.resource.length > 0, 'every policy entry has a resource');
  }

  // Journal lists the retirements and the archive entry.
  const manifest = JSON.parse(readFileSync(path.join(cfg, 'oc-harness-setup.manifest.json'), 'utf8'));
  const retired = manifest.files.filter((f) => f.action === 'retired').map((f) => f.path).sort();
  assert.deepEqual(retired, ['agents/build.md', 'commands/build.md', 'commands/goal.md', 'reference/old.md', 'scripts/old.ps1', 'skills/goal/SKILL.md', 'skills/old/SKILL.md'].sort());
  const archivedEntries = manifest.files.filter((f) => f.action === 'archived');
  assert.equal(archivedEntries.length, 1, 'one archived journal entry');
  assert.equal(archivedEntries[0].path, 'skills/edited/SKILL.md', 'archived entry names the edited skill');
  assert.ok(String(archivedEntries[0].archivedTo || '').length > 0, 'archived entry records archivedTo');
  const agentEntry = manifest.files.find((f) => String(f.path).replace(/\\/g, '/') === 'agents/verify-agent.md');
  assert.ok(agentEntry, 'the edited agent has a journal entry');
  assert.equal(agentEntry.action, 'kept', 'an adopter-edited incoming file journals kept');
  assert.equal(posix(agentEntry.newPath || ''), 'agents/verify-agent.md.new', 'the kept entry records the .new beside it');
  assert.equal(agentEntry.prevHash, sha256Text(userAgent), 'the kept entry records the adopter bytes it found');

  // Separator-normalization pin: a second run sees the agent still held by
  // the adopter and must carry forward the earlier kept truth, even though the
  // prior manifest spelled paths with forward slashes. Otherwise --uninstall
  // would treat a file the harness never wrote as its own.
  // Simulate a prior manifest written with the other separator: rewrite every
  // journal path to forward slashes before the second run reads it.
  const manifestPath = path.join(cfg, 'oc-harness-setup.manifest.json');
  const manifestX = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const f of manifestX.files) f.path = String(f.path).replace(/\\/g, '/');
  writeFileSync(manifestPath, JSON.stringify(manifestX, null, 2) + '\n');
  assert.ok(manifestX.files.some((f) => String(f.path).includes('/')), 'rewritten manifest keeps at least one forward-slash path');
  assert.ok(manifestX.files.every((f) => !String(f.path).includes('\\')), 'rewritten manifest has no backslash paths');
  const r2 = runCli(['setup'], { env, input: 'y\n', cwd: cfg });
  assert.equal(r2.status, 0, `second setup exit was ${r2.status}\nSTDOUT:\n${r2.stdout}\nSTDERR:\n${r2.stderr}`);
  const manifest2 = JSON.parse(readFileSync(path.join(cfg, 'oc-harness-setup.manifest.json'), 'utf8'));
  const agentEntry2 = manifest2.files.find((f) => String(f.path).replace(/\\/g, '/') === 'agents/verify-agent.md');
  assert.ok(agentEntry2, 'the edited agent still has a journal entry after a second run');
  assert.equal(agentEntry2.action, 'kept', 'second run did not downgrade kept to skip');
  assert.ok(String(agentEntry2.prevHash || '').length > 0, 'second run kept the adopter prevHash');
  assert.equal(readFileSync(path.join(cfg, 'agents', 'verify-agent.md'), 'utf8'), userAgent, 'the adopter file is still byte-identical after the second run');

  shared.cfg = cfg;
  shared.env = env;
  shared.oldAgents = oldAgents;
  shared.oldBuildAgent = priorTree['agents/build.md'];
  shared.editedY = editedY;
  shared.userAgent = userAgent;
});

/* ---------------- 0.4.x plugin residue + kept template + same-version re-run ---------------- */

test('0.4.x upgrade drops plugin residue, keeps an edited template with the new one beside it, and keeps a re-added plugin on a same-version re-run', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const shippedTemplate = readFileSync(path.join(PKG_ROOT, 'state-seed', 'template.md'), 'utf8');
  const originalBytes = '# original template v0.4.1\n';
  // Adopter-edited yet still legal under the doctor's fixed key order, so the
  // run grades the install policy rather than this fixture's own file.
  const editedBytes = [
    '# adopter-edited template — my own copy',
    'id: <session-id>',
    'title: <status> <work>',
    'status: <active|parked|done>',
    'goal: <one line>',
    'next: <the single next action>',
    'artifacts: <path — what it is>',
    'decisions: <gap -> call -> evidence>',
    'open: <question still unanswered>',
    '',
  ].join('\n');
  assert.ok(editedBytes !== shippedTemplate, 'edited bytes differ from the shipped template');
  assert.ok(originalBytes !== shippedTemplate, 'original bytes differ from the shipped template');
  assert.ok(editedBytes !== originalBytes, 'edited bytes differ from the prior hash');
  const origHash = sha256Text(originalBytes);

  // Fixture A: prior 0.4.1 carries the retired distro plugin; template on disk is edited.
  const baseA = mkdtempSync(path.join(os.tmpdir(), 'oc-04x-a-'));
  const cfgA = path.join(baseA, 'cfg');
  mkdirSync(path.join(cfgA, 'state'), { recursive: true });
  const fakeBinA = path.join(baseA, 'fakebin');
  mkdirSync(fakeBinA, { recursive: true });
  writeFakeOpencode(fakeBinA);
  writeFileSync(path.join(cfgA, 'opencode.jsonc'), JSON.stringify({ model: 'keep-me', plugins: ['oc-flight-deck'] }, null, 2));
  writeFileSync(path.join(cfgA, 'state', 'template.md'), editedBytes);
  writeFileSync(path.join(cfgA, 'oc-harness-setup.manifest.json'), JSON.stringify({
    package: 'oc-harness-setup', version: '0.4.1', created: new Date().toISOString(),
    configDir: cfgA,
    files: [
      { path: 'state/template.md', hash: origHash, action: 'written' },
      { path: 'opencode.jsonc', hash: sha256Text('prior-merged'), action: 'merged' },
    ],
  }, null, 2));
  try {
    const rA = runCli(['setup'], {
      env: {
        OPENCODE_CONFIG_DIR: cfgA,
        FAKE_OPENCODE_CONFIG: cfgA,
        PATH: fakePath(fakeBinA),
      },
      input: 'y\n',
      cwd: cfgA,
    });
    assert.equal(rA.status, 0, `fixture A setup exit was ${rA.status}\nSTDOUT:\n${rA.stdout}\nSTDERR:\n${rA.stderr}`);
    const mergedA = JSON.parse(stripLineComments(readFileSync(path.join(cfgA, 'opencode.jsonc'), 'utf8')));
    assert.ok(!(mergedA.plugins || []).includes('oc-flight-deck'), 'older-prior run drops the retired distro plugin');
    assert.equal(readFileSync(path.join(cfgA, 'state', 'template.md'), 'utf8'), editedBytes, 'the edited template is byte-identical');
    assert.equal(readFileSync(path.join(cfgA, 'state', 'template.md.new'), 'utf8'), shippedTemplate, 'the shipped template landed beside it as state/template.md.new');
    assert.ok(!existsSync(path.join(cfgA, 'state', 'archive')), 'a kept template is never archived');
  } finally {
    rmSync(baseA, { recursive: true, force: true });
  }

  // Fixture B: same-version re-run keeps a deliberately re-added plugin, and a
  // 1.x `[specifier, options]` tuple is reduced to its specifier (2.2.0 drops a
  // tuple entry outright, so keeping the tuple would silently unload the plugin).
  const baseB = mkdtempSync(path.join(os.tmpdir(), 'oc-04x-b-'));
  const cfgB = path.join(baseB, 'cfg');
  mkdirSync(path.join(cfgB, 'state'), { recursive: true });
  const fakeBinB = path.join(baseB, 'fakebin');
  mkdirSync(fakeBinB, { recursive: true });
  writeFakeOpencode(fakeBinB);
  writeFileSync(path.join(cfgB, 'opencode.jsonc'), JSON.stringify({ model: 'keep-me', plugins: ['oc-flight-deck', 'adopter-plugin', ['legacy-tuple', { opt: 1 }]] }, null, 2));
  writeFileSync(path.join(cfgB, 'state', 'template.md'), editedBytes);
  writeFileSync(path.join(cfgB, 'oc-harness-setup.manifest.json'), JSON.stringify({
    package: 'oc-harness-setup', version: EXPECTED_VERSION, created: new Date().toISOString(),
    configDir: cfgB,
    files: [
      { path: 'state/template.md', hash: origHash, action: 'written' },
      { path: 'opencode.jsonc', hash: sha256Text('prior-merged'), action: 'merged' },
    ],
  }, null, 2));
  try {
    const rB = runCli(['setup'], {
      env: {
        OPENCODE_CONFIG_DIR: cfgB,
        FAKE_OPENCODE_CONFIG: cfgB,
        FAKE_OPENCODE_PLUGINS: 'oc-flight-deck adopter-plugin legacy-tuple',
        PATH: fakePath(fakeBinB),
      },
      input: 'y\n',
      cwd: cfgB,
    });
    assert.equal(rB.status, 0, `fixture B setup exit was ${rB.status}\nSTDOUT:\n${rB.stdout}\nSTDERR:\n${rB.stderr}`);
    const mergedB = JSON.parse(stripLineComments(readFileSync(path.join(cfgB, 'opencode.jsonc'), 'utf8')));
    assert.ok((mergedB.plugins || []).includes('oc-flight-deck'), 'same-version re-run keeps the re-added distro plugin');
    assert.ok((mergedB.plugins || []).includes('adopter-plugin'), 'same-version re-run keeps the adopter plugin');
    assert.ok((rB.stdout || '').includes('normalized the 1.x plugin tuple'), 'the tuple reduction is reported, not silent');
    assert.ok(
      (mergedB.plugins || []).every((e) => typeof e === 'string'),
      `every emitted plugins entry is a 2.2.0 specifier string (saw ${JSON.stringify(mergedB.plugins)})`
    );
    assert.ok((mergedB.plugins || []).includes('legacy-tuple'), 'the tuple plugin is kept, reduced to its specifier');
    assert.ok(!(rB.stdout || '').includes('legacy-tuple System.'), 'the doctor never saw an unresolved tuple entry');
  } finally {
    rmSync(baseB, { recursive: true, force: true });
  }
});

/* ---------------- additive policy: keep the adopter's bytes, update our own ---------------- */

// The install policy is per destination state, never per file name:
//   package-owned (still matches what we installed) → updated in place
//   adopter-owned (matches nothing we recorded)     → kept byte-identical,
//                                                     new bytes beside it as .new
test('an edited file is kept byte-identical with a .new beside it; an unmodified package file updates in place', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-additive-');
  try {
    const shippedCommand = readFileSync(path.join(PKG_ROOT, 'commands', 'loop.md'), 'utf8');
    const shippedSkill = readFileSync(path.join(PKG_ROOT, 'skills', 'loop', 'SKILL.md'), 'utf8');
    const adopterCommand = `${shippedCommand}\n<!-- my own note in this command -->\n`;
    const priorSkill = `${shippedSkill}\n<!-- the previous release of this skill -->\n`;
    mkdirSync(path.join(cfg, 'commands'), { recursive: true });
    mkdirSync(path.join(cfg, 'skills', 'loop'), { recursive: true });
    writeFileSync(path.join(cfg, 'commands', 'loop.md'), adopterCommand);
    writeFileSync(path.join(cfg, 'skills', 'loop', 'SKILL.md'), priorSkill);
    writePriorJournal(cfg, [
      { path: 'commands/loop.md', hash: sha256Text(shippedCommand), action: 'written' },
      { path: 'skills/loop/SKILL.md', hash: sha256Text(priorSkill), action: 'written' },
    ]);

    const r = run();
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);

    assert.equal(readFileSync(path.join(cfg, 'commands', 'loop.md'), 'utf8'), adopterCommand, 'the adopter-edited file is byte-identical');
    assert.equal(
      readFileSync(path.join(cfg, 'commands', 'loop.md.new'), 'utf8'),
      shippedCommand,
      'the new version landed beside it as commands/loop.md.new'
    );
    assert.ok(!existsSync(path.join(cfg, 'state', 'archive')), 'a kept file is never archived');

    assert.equal(readFileSync(path.join(cfg, 'skills', 'loop', 'SKILL.md'), 'utf8'), shippedSkill, 'the unmodified package file was updated in place');
    assert.ok(!existsSync(path.join(cfg, 'skills', 'loop', 'SKILL.md.new')), 'no .new is written beside an updated package file');

    const keptEntry = journalFor(cfg, 'commands/loop.md')[0];
    assert.equal(keptEntry?.action, 'kept', 'the kept file journals kept');
    assert.equal(posix(keptEntry?.newPath || ''), 'commands/loop.md.new', 'the kept entry records the .new path');
    assert.equal(journalFor(cfg, 'skills/loop/SKILL.md')[0]?.action, 'overwritten', 'the updated file journals overwritten');

    assert.match(r.stdout || '', /kept user file commands\/loop\.md, wrote commands\/loop\.md\.new/, 'the keep is reported with its .new path');
    assert.match(
      r.stdout || '',
      /policy\s+:\s+1 updated in place \(unmodified package files\) · 1 kept \+ \.new written \(your files\)/,
      'the summary counts each policy'
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- additive merge: the adopter's key value wins, and says so ---------------- */

test('a user-set install-owned key survives the merge, is reported, and the shipped deny block still lands', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-additive-merge-');
  try {
    const ownDeny = { action: 'tool.use', resource: 'read:*my-own-secret*', effect: 'deny' };
    mkdirSync(cfg, { recursive: true });
    writeFileSync(
      path.join(cfg, 'opencode.jsonc'),
      JSON.stringify(
        { default_agent: 'my-own-agent', tool_output: { max_lines: 500 }, policies: [ownDeny] },
        null,
        2
      )
    );

    const r = run();
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    const merged = parseJsoncForTest(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8'));

    assert.equal(merged.default_agent, 'my-own-agent', 'the user value for an install-owned key wins');
    assert.equal(merged.tool_output?.max_lines, 500, 'a collided subkey keeps the user value');
    assert.equal(merged.tool_output?.max_bytes, 51200, 'a subkey the user never set still arrives from the distro');
    assert.match(
      r.stdout || '',
      /kept your value\(s\) for install-owned key\(s\): default_agent, tool_output\.max_lines/,
      'each collided key is reported by name'
    );

    const shippedPolicies = parseJsoncForTest(readFileSync(path.join(PKG_ROOT, 'opencode.jsonc'), 'utf8')).policies;
    const policies = merged.policies || [];
    assert.equal(policies.length, shippedPolicies.length + 1, 'the shipped deny block is kept and the user entry is added');
    assert.equal(policies[0]?.resource, ownDeny.resource, 'the user rule leads, so a shipped deny can never be shadowed');
    for (const rule of shippedPolicies) {
      assert.ok(policies.some((p) => JSON.stringify(p) === JSON.stringify(rule)), `shipped deny survives: ${rule.resource}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- test 5 (before uninstall): negative doctor ---------------- */

test('doctor fails naming state/template.md when it is removed', { skip: WIN_SKIP, timeout: 120000 }, () => {
  if (!shared.cfg) {
    console.log('SKIP: install test was skipped — nothing to grade; skipping');
    return;
  }
  rmSync(path.join(shared.cfg, 'state', 'template.md'), { force: true });
  const script = path.join(shared.cfg, 'scripts', 'harness-doctor.mjs');
  const r = spawnSync(process.execPath, [script, '-ConfigDir', shared.cfg], { encoding: 'utf8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.notEqual(r.status, 0, `doctor should fail without state/template.md:\n${out}`);
  assert.ok(out.includes('state/template.md'), 'a law failure names the missing path');
});

/* ---------------- T1: doctor grades a config with no permissions key ---------------- */

test('doctor grades a config with no permissions key instead of crashing', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-noperms-'));
  try {
    const cfg = makeDoctorFixture(base, { default_agent: 'orchestrator' });
    const { status, out } = runDoctorNode(cfg);
    assert.equal(status, 1, `doctor should exit 1 on a permissions-less config:\n${out}`);
    assert.ok(!out.includes('cannot be found on this object'), 'no StrictMode property crash');
    assert.ok(out.includes('deny set survives --auto'), 'deny law names the missing block');
    assert.ok(out.includes('Summary:'), 'report prints the summary');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- T2: doctor secret-pointer law ---------------- */

test('doctor fails a literal apiKey but accepts a pointer', { skip: WIN_SKIP, timeout: 120000 }, () => {
  const distroPerms = parseJsoncForTest(readFileSync(path.join(PKG_ROOT, 'opencode.jsonc'), 'utf8')).permissions;
  const baseA = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-pointer-'));
  try {
    const cfgA = makeDoctorFixture(baseA, {
      default_agent: 'orchestrator',
      permissions: distroPerms,
      provider: { openai: { options: { apiKey: '{env:OPENAI_API_KEY}' } } },
    });
    const { out } = runDoctorNode(cfgA);
    assert.ok(out.includes('[PASS] no secret-like property names'), `pointer accepted:\n${out}`);
  } finally {
    rmSync(baseA, { recursive: true, force: true });
  }
  const baseB = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-literal-'));
  try {
    const cfgB = makeDoctorFixture(baseB, {
      default_agent: 'orchestrator',
      permissions: distroPerms,
      apiKey: 'sk-literal-value',
    });
    const { status, out } = runDoctorNode(cfgB);
    assert.ok(out.includes('[FAIL] no secret-like property names'), `literal failed:\n${out}`);
    assert.equal(status, 1, `doctor should exit 1 on a literal secret:\n${out}`);
    assert.ok(!out.includes('sk-literal-value'), 'literal value never printed');
  } finally {
    rmSync(baseB, { recursive: true, force: true });
  }
});

/* ---------------- test 4: uninstall ---------------- */

test('uninstall keeps adopter edits, removes harness files, restores originals', { skip: WIN_SKIP }, () => {
  if (!shared.cfg) {
    console.log('SKIP: install test was skipped — nothing to uninstall; skipping');
    return;
  }
  const adopterNote = '\n- adopter note: kept\n';
  appendFileSync(path.join(shared.cfg, 'state', 'lessons.md'), adopterNote);

  const r = runCli(['setup', '--uninstall'], { env: shared.env, cwd: shared.cfg });
  assert.equal(r.status, 0, `uninstall exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);

  // Adopter-modified state survives.
  const lessons = readFileSync(path.join(shared.cfg, 'state', 'lessons.md'), 'utf8');
  assert.ok(lessons.includes('adopter note'), 'modified state/lessons.md kept');

  // Harness files are gone. The adopter-edited orchestrator was never ours, so
  // it stays byte-identical and only the `.new` beside it is swept.
  for (const rel of ['skills/loop/SKILL.md', 'commands/loop.md']) {
    assert.ok(!existsSync(path.join(shared.cfg, rel)), `${rel} removed`);
  }
  assert.ok(!existsSync(path.join(shared.cfg, 'agents', 'verify-agent.md.new')), 'agents/verify-agent.md.new swept');

  // Pre-install originals come back from the backup.
  assert.equal(readFileSync(path.join(shared.cfg, 'AGENTS.md'), 'utf8'), shared.oldAgents, 'original AGENTS.md restored');
  assert.equal(readFileSync(path.join(shared.cfg, 'agents', 'build.md'), 'utf8'), shared.oldBuildAgent, 'retired file restored from backup');
  assert.equal(readFileSync(path.join(shared.cfg, 'skills', 'edited', 'SKILL.md'), 'utf8'), shared.editedY, 'archived file restored from backup (pre-install bytes Y)');
  assert.equal(readFileSync(path.join(shared.cfg, 'agents', 'verify-agent.md'), 'utf8'), shared.userAgent, 'the adopter-edited agent was never written over');
  const restoredConfig = JSON.parse(stripLineComments(readFileSync(path.join(shared.cfg, 'opencode.jsonc'), 'utf8')));
  assert.equal(restoredConfig.model, 'keeper-model', 'adopter opencode.jsonc restored');
  assert.ok(!('default_agent' in restoredConfig), 'harness default_agent gone after restore');
});

/* ---------------- regression: /goal belongs to the host ---------------- */

// OpenCode v2.2.1 ships a first-party `/goal` session-continuation command
// (`Usage: /goal <objective> | pause | resume | clear`). A custom
// `commands/goal.md` collides with it, so this starter's end-to-end looper
// ships as `/loop` and says so in its own body.
test('custom /goal is not shipped; /loop is the 1:1 command for the loop skill', { skip: WIN_SKIP }, () => {
  assert.ok(!existsSync(path.join(PKG_ROOT, 'commands', 'goal.md')), 'no custom commands/goal.md (the host owns that name)');
  assert.ok(!existsSync(path.join(PKG_ROOT, 'skills', 'goal', 'SKILL.md')), 'no skills/goal — the skill is loop');

  const commandPath = path.join(PKG_ROOT, 'commands', 'loop.md');
  const skillPath = path.join(PKG_ROOT, 'skills', 'loop', 'SKILL.md');
  assert.ok(existsSync(commandPath), 'commands/loop.md ships');
  assert.ok(existsSync(skillPath), 'skills/loop/SKILL.md ships');

  const command = readFileSync(commandPath, 'utf8');
  assert.match(command, /^---\n[\s\S]*?^description:\s*\S/m, 'loop command carries a description (doctor Law 15)');
  assert.ok(command.includes('# /loop'), 'loop command names /loop');
  assert.ok(command.includes('native `/goal`'), 'loop command records the native-/goal distinction');

  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /^---\n[\s\S]*?^name:\s*loop\s*$/m, 'loop skill frontmatter names loop');
  assert.ok(skill.includes('# loop'), 'loop skill names loop');

  const cfg = parseJsoncForTest(readFileSync(path.join(PKG_ROOT, 'opencode.jsonc'), 'utf8'));
  const allows = (cfg.permissions || [])
    .filter((p) => p.action === 'skill' && p.effect === 'allow')
    .map((p) => p.resource);
  assert.ok(allows.includes('loop'), 'the skill allow names loop');
  assert.ok(!allows.includes('goal'), 'no skill allow names the retired goal');
});

/* ---------------- regression matrix: the /goal → /loop rename, by state ---------------- */

// The rename is not a special case in the installer: `commands/goal.md` and
// `skills/goal/SKILL.md` are just prior-journal paths the new pack no longer
// ships, so every row below is one state of the generic decision table in
// bin/cli.js — retireStale (prior entry settled / absent / hash-match /
// hash-mismatch / no hash) feeding mergeJsonc's retiredSkills allow-prune.
// The prune MUST key on a `skills/<id>/...` path: a retired command of the
// same name proves nothing about the skill, so the last row pins that seam.
//
// Each fixture is <base>/cfg + <base>/fakebin under os.tmpdir(). The config
// dir sits one level down so the installer's sibling snapshot
// (<cfg>.bak-oc-harness-setup-*) lands inside `base` and one
// rmSync(base) removes the whole row — never the real config, never the
// temp root.

const GOAL_COMMAND_TEXT = '---\ndescription: adopter /goal command\n---\n# /goal\n';
const GOAL_SKILL_TEXT = '---\nname: goal\ndescription: adopter goal skill\n---\n# goal\n';

function makeGoalFixture(prefix) {
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

function writeGoalPair(cfg, commandText = GOAL_COMMAND_TEXT, skillText = GOAL_SKILL_TEXT) {
  mkdirSync(path.join(cfg, 'commands'), { recursive: true });
  mkdirSync(path.join(cfg, 'skills', 'goal'), { recursive: true });
  writeFileSync(path.join(cfg, 'commands', 'goal.md'), commandText);
  writeFileSync(path.join(cfg, 'skills', 'goal', 'SKILL.md'), skillText);
}

// The adopter allow that may die ONLY on a `skills/goal/...` retirement.
function writeGoalAllowConfig(cfg) {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    path.join(cfg, 'opencode.jsonc'),
    JSON.stringify({ permissions: [{ action: 'skill', resource: 'goal', effect: 'allow' }] }, null, 2)
  );
}

function writePriorJournal(cfg, files) {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(
    path.join(cfg, 'oc-harness-setup.manifest.json'),
    JSON.stringify({
      package: 'oc-harness-setup', version: '0.5.0', created: new Date(0).toISOString(),
      configDir: cfg, files,
    }, null, 2)
  );
}

const posix = (p) => String(p).replace(/\\/g, '/');
const permsOf = (cfg) => JSON.parse(stripLineComments(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8'))).permissions || [];
const journalFor = (cfg, rel) => JSON.parse(readFileSync(path.join(cfg, 'oc-harness-setup.manifest.json'), 'utf8'))
  .files.filter((f) => posix(f.path) === rel);
const allowsOf = (cfg) => (JSON.parse(stripLineComments(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8'))).permissions || [])
  .filter((p) => p.action === 'skill' && p.effect === 'allow')
  .map((p) => p.resource);
const legacyArchivedAt = (cfg, ...parts) => path.join(cfg, 'state', 'archive', 'legacy-0.3.x', ...parts);

// Adopter rules beyond the single goal allow: the merge's prune is asked about
// every user rule, so the fixture writes whatever permission list a row needs.
function writeConfigRules(cfg, permissions) {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify({ permissions }, null, 2));
}

// Deterministic, fixture-local filesystem fault. The child CLI loads this CJS
// shim with --require BEFORE bin/cli.js, and the named fs call refuses exactly
// one path once per process — no ACLs, no host state, no test seam in the
// product. The shim lives inside the row's temp base, so rmSync(base) removes
// it, and every other path in the run reads normally.
function writeFsFaultInjector(base, { op, target }) {
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

test('fresh install: /loop ships paired and no /goal is generated', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-goal-fresh-');
  try {
    assert.ok(!existsSync(cfg), 'the fixture starts with no config dir');
    const r = run();
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /no prior install manifest/, 'a fresh install states there is no prior manifest to retire from');

    // Paired: command and skill both land, byte-for-byte the shipped pair.
    assert.ok(existsSync(path.join(cfg, 'commands', 'loop.md')), 'commands/loop.md installed');
    assert.ok(existsSync(path.join(cfg, 'skills', 'loop', 'SKILL.md')), 'skills/loop/SKILL.md installed');
    assert.equal(
      readFileSync(path.join(cfg, 'commands', 'loop.md'), 'utf8'),
      readFileSync(path.join(PKG_ROOT, 'commands', 'loop.md'), 'utf8'),
      'the installed loop command is the shipped one'
    );
    assert.equal(
      readFileSync(path.join(cfg, 'skills', 'loop', 'SKILL.md'), 'utf8'),
      readFileSync(path.join(PKG_ROOT, 'skills', 'loop', 'SKILL.md'), 'utf8'),
      'the installed loop skill is the shipped one'
    );

    // Nothing generates the retired name: no command, no skill dir, no allow.
    assert.ok(!existsSync(path.join(cfg, 'commands', 'goal.md')), 'no /goal command is generated');
    assert.ok(!existsSync(path.join(cfg, 'skills', 'goal')), 'no skills/goal directory is generated');
    assert.deepEqual([...allowsOf(cfg)].sort(), [...EXPECTED_SKILLS].sort(), 'the allowlist is exactly the 6 shipped skills — no goal allow');

    assert.equal(journalFor(cfg, 'commands/loop.md')[0]?.action, 'written', 'the loop command is journaled as written');
    assert.equal(journalFor(cfg, 'skills/loop/SKILL.md')[0]?.action, 'written', 'the loop skill is journaled as written');
    const goalPaths = JSON.parse(readFileSync(path.join(cfg, 'oc-harness-setup.manifest.json'), 'utf8'))
      .files.map((f) => posix(f.path)).filter((p) => p.includes('goal'));
    assert.deepEqual(goalPaths, [], `no goal path is journaled (saw ${JSON.stringify(goalPaths)})`);
    assert.ok(!existsSync(path.join(cfg, 'state', 'archive')), 'a fresh install archives nothing');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('no prior manifest: an adopter /goal pair and its allow survive untouched', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-goal-noprior-');
  try {
    writeGoalPair(cfg);
    writeGoalAllowConfig(cfg);
    const r = run();
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /no prior install manifest/, 'the install says it cannot prove ownership of old files');

    assert.equal(readFileSync(path.join(cfg, 'commands', 'goal.md'), 'utf8'), GOAL_COMMAND_TEXT, 'the adopter /goal command is byte-identical');
    assert.equal(readFileSync(path.join(cfg, 'skills', 'goal', 'SKILL.md'), 'utf8'), GOAL_SKILL_TEXT, 'the adopter goal skill is byte-identical');
    assert.deepEqual(
      [...allowsOf(cfg)].sort(),
      ['goal', ...EXPECTED_SKILLS].sort(),
      'the goal allow is kept alongside the 6 shipped allows'
    );
    const settled = ['commands/goal.md', 'skills/goal/SKILL.md']
      .flatMap((rel) => journalFor(cfg, rel))
      .filter((f) => f.action === 'retired' || f.action === 'archived');
    assert.deepEqual(settled, [], 'nothing was retired or archived without a manifest to prove ownership');
    assert.ok(!existsSync(legacyArchivedAt(cfg)), 'no legacy archive was created');
    assert.ok(existsSync(path.join(cfg, 'commands', 'loop.md')), 'the install still landed the loop command');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('tracked hash-match: the /goal pair retires and only then is its allow pruned', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-goal-retire-');
  try {
    writeGoalPair(cfg);
    writeGoalAllowConfig(cfg);
    writePriorJournal(cfg, [
      { path: 'commands/goal.md', hash: sha256Text(GOAL_COMMAND_TEXT), action: 'written' },
      { path: 'skills/goal/SKILL.md', hash: sha256Text(GOAL_SKILL_TEXT), action: 'written' },
    ]);
    const r = run();
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);

    assert.ok(!existsSync(path.join(cfg, 'commands', 'goal.md')), 'the unmodified /goal command is gone');
    assert.ok(!existsSync(path.join(cfg, 'skills', 'goal', 'SKILL.md')), 'the unmodified goal skill is gone');
    assert.ok(!existsSync(path.join(cfg, 'skills', 'goal')), 'the emptied skills/goal directory is pruned');

    const pairs = [
      ['commands/goal.md', sha256Text(GOAL_COMMAND_TEXT)],
      ['skills/goal/SKILL.md', sha256Text(GOAL_SKILL_TEXT)],
    ];
    for (const [rel, hash] of pairs) {
      const entries = journalFor(cfg, rel);
      assert.equal(entries.length, 1, `${rel}: one journal entry`);
      assert.equal(entries[0].action, 'retired', `${rel}: journaled as retired`);
      assert.equal(entries[0].hash, hash, `${rel}: the prior hash is preserved for --uninstall restore`);
    }
    assert.ok(!existsSync(legacyArchivedAt(cfg)), 'hash-matched content is deleted, never archived');

    assert.deepEqual([...allowsOf(cfg)].sort(), [...EXPECTED_SKILLS].sort(), 'the goal allow is pruned with the retired skill');
    assert.match(r.stdout || '', /dropped stale skill allows for retired skills: goal/, 'the prune is reported, not silent');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('tracked hash-mismatch: each edited /goal file archives on its own path, allow pruned', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-goal-archive-');
  try {
    const editedCommand = '---\ndescription: adopter-edited /goal command\n---\n# /goal edited\n';
    const editedSkill = '---\nname: goal\ndescription: adopter-edited goal skill\n---\n# goal edited\n';
    const staleCommand = '---\ndescription: prior /goal command\n---\n# /goal prior\n';
    const staleSkill = '---\nname: goal\ndescription: prior goal skill\n---\n# goal prior\n';
    writeGoalPair(cfg, editedCommand, editedSkill);
    writeGoalAllowConfig(cfg);
    writePriorJournal(cfg, [
      { path: 'commands/goal.md', hash: sha256Text(staleCommand), action: 'written' },
      { path: 'skills/goal/SKILL.md', hash: sha256Text(staleSkill), action: 'written' },
    ]);
    const r = run();
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);

    assert.ok(!existsSync(path.join(cfg, 'commands', 'goal.md')), 'the edited /goal command left the active tree');
    assert.ok(!existsSync(path.join(cfg, 'skills', 'goal', 'SKILL.md')), 'the edited goal skill left the active tree');
    assert.ok(!existsSync(path.join(cfg, 'skills', 'goal')), 'the emptied skills/goal directory is pruned');

    const archivedCommand = legacyArchivedAt(cfg, 'commands', 'goal.md');
    const archivedSkill = legacyArchivedAt(cfg, 'skills', 'goal', 'SKILL.md');
    assert.ok(existsSync(archivedCommand), 'the edited command is archived');
    assert.ok(existsSync(archivedSkill), 'the edited skill is archived');
    assert.notEqual(archivedCommand, archivedSkill, 'one archive path per file, never one shared blob');
    assert.equal(readFileSync(archivedCommand, 'utf8'), editedCommand, 'the command archive holds the edited bytes');
    assert.equal(readFileSync(archivedSkill, 'utf8'), editedSkill, 'the skill archive holds the edited bytes');

    const archived = [
      [journalFor(cfg, 'commands/goal.md'), 'state/archive/legacy-0.3.x/commands/goal.md', sha256Text(staleCommand)],
      [journalFor(cfg, 'skills/goal/SKILL.md'), 'state/archive/legacy-0.3.x/skills/goal/SKILL.md', sha256Text(staleSkill)],
    ];
    for (const [entries, archiveRel, hash] of archived) {
      assert.equal(entries.length, 1, `${archiveRel}: one journal entry`);
      assert.equal(entries[0].action, 'archived', `${archiveRel}: journaled as archived`);
      assert.equal(posix(entries[0].archivedTo), archiveRel, `${archiveRel}: archivedTo names this file, not a sibling`);
      assert.equal(entries[0].hash, hash, `${archiveRel}: the prior hash is preserved for --uninstall restore`);
    }

    assert.deepEqual([...allowsOf(cfg)].sort(), [...EXPECTED_SKILLS].sort(), 'archiving the skill file still prunes its allow');
    assert.match(r.stdout || '', /dropped stale skill allows for retired skills: goal/, 'the prune is reported, not silent');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('no prior hash: adopter-owned /goal files and their allow are preserved', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-goal-nohash-');
  try {
    const editedCommand = '---\ndescription: unhashed /goal command\n---\n# /goal unhashed\n';
    const editedSkill = '---\nname: goal\ndescription: unhashed goal skill\n---\n# goal unhashed\n';
    writeGoalPair(cfg, editedCommand, editedSkill);
    writeGoalAllowConfig(cfg);
    writePriorJournal(cfg, [
      { path: 'commands/goal.md', action: 'written' },
      { path: 'skills/goal/SKILL.md', action: 'written' },
    ]);
    const r = run();
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.match(r.stdout || '', /no prior hash to compare/, 'the reason for keeping is logged, not implied');

    assert.equal(readFileSync(path.join(cfg, 'commands', 'goal.md'), 'utf8'), editedCommand, 'the command is byte-identical');
    assert.equal(readFileSync(path.join(cfg, 'skills', 'goal', 'SKILL.md'), 'utf8'), editedSkill, 'the skill is byte-identical');
    assert.deepEqual(
      [...allowsOf(cfg)].sort(),
      ['goal', ...EXPECTED_SKILLS].sort(),
      'a hashless prior entry proves no ownership, so the goal allow survives'
    );
    const settled = ['commands/goal.md', 'skills/goal/SKILL.md']
      .flatMap((rel) => journalFor(cfg, rel))
      .filter((f) => f.action === 'retired' || f.action === 'archived');
    assert.deepEqual(settled, [], 'nothing was retired or archived without a prior hash');
    assert.ok(!existsSync(legacyArchivedAt(cfg)), 'no legacy archive was created');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('settled (retired/archived) or already-absent /goal skill paths still prune the allow, without acting twice', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const rows = [
    {
      label: 'prior entry already retired',
      entry: { path: 'skills/goal/SKILL.md', hash: sha256Text(GOAL_SKILL_TEXT), action: 'retired' },
      carriedAction: 'retired',
    },
    {
      label: 'prior entry already archived',
      entry: {
        path: 'skills/goal/SKILL.md', hash: sha256Text(GOAL_SKILL_TEXT), action: 'archived',
        archivedTo: 'state/archive/legacy-0.3.x/skills/goal/SKILL.md',
      },
      carriedAction: 'archived',
    },
    {
      label: 'tracked path already absent',
      entry: { path: 'skills/goal/SKILL.md', hash: sha256Text(GOAL_SKILL_TEXT), action: 'written' },
      carriedAction: null,
    },
  ];
  for (const row of rows) {
    const { base, cfg, run } = makeGoalFixture('oc-goal-settled-');
    try {
      writeGoalAllowConfig(cfg);
      writePriorJournal(cfg, [row.entry]);
      const r = run();
      assert.equal(r.status, 0, `${row.label}: setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
      assert.deepEqual(
        [...allowsOf(cfg)].sort(),
        [...EXPECTED_SKILLS].sort(),
        `${row.label}: the goal allow is pruned — the skill is still gone`
      );
      const entries = journalFor(cfg, 'skills/goal/SKILL.md');
      if (row.carriedAction) {
        assert.equal(entries.length, 1, `${row.label}: the settled entry is carried forward exactly once`);
        assert.equal(entries[0].action, row.carriedAction, `${row.label}: the settled action is preserved`);
      } else {
        assert.deepEqual(entries, [], `${row.label}: an already-absent staged path is not journaled again`);
      }
      assert.ok(!existsSync(legacyArchivedAt(cfg)), `${row.label}: nothing is archived a second time`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test('command-only /goal retirement never prunes the goal skill allow — the doctor reports the dangling allow', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-goal-cmdonly-');
  try {
    // A prior journal that tracked ONLY the command: nothing proves the skill
    // side belongs to the installer, so `goal` must not enter retiredSkills and
    // the adopter's allow must be kept. The leftover dangling allow is then the
    // doctor's finding (Law 14) — never the merge's silent cleanup. A merge
    // that derived the skill id from the command name would prune the allow and
    // this test goes red on the allow itself.
    mkdirSync(path.join(cfg, 'commands'), { recursive: true });
    writeFileSync(path.join(cfg, 'commands', 'goal.md'), GOAL_COMMAND_TEXT);
    writeGoalAllowConfig(cfg);
    writePriorJournal(cfg, [
      { path: 'commands/goal.md', hash: sha256Text(GOAL_COMMAND_TEXT), action: 'written' },
    ]);
    const r = run();
    assert.equal(
      r.status,
      1,
      `the doctor must reject the dangling allow, got exit ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`
    );
    assert.equal(journalFor(cfg, 'commands/goal.md')[0]?.action, 'retired', 'the tracked, unmodified /goal command is retired');
    assert.ok(!existsSync(path.join(cfg, 'skills', 'goal')), 'no goal skill directory appears from anywhere');
    assert.ok(allowsOf(cfg).includes('goal'), 'the adopter allow survives a command-only retirement');
    assert.ok(!/dropped stale skill allows/.test(r.stdout || ''), 'the merge dropped nothing — no skill path retired');
    assert.match(r.stdout || '', /dangling allow entries with no directory: goal/, 'the doctor names the dangling allow');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- failure branches: an unreadable tracked path is a refusal ---------------- */

// Both filesystem refusals the sweep can meet must land on the decision
// table's "present, path unreadable → kept (refused), no skill ID" row: the
// file is kept, its skill ID is NOT added, the sweep continues, and the
// manifest/config merge still completes. Before the hash read was wrapped, a
// readFileSync failure escaped retireStale into main().catch: exit 1 with the
// install half-done (backup taken, staging never started). The rows differ
// only in the operation that fails, so each logs its own reason.
test('goal unreadable: a stat failure and a content-read failure are refusals, not aborts', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const rows = [
    { op: 'statSync', reason: /keep\s+skills\/goal\/SKILL\.md \(unreadable — refusing\)/ },
    { op: 'readFileSync', reason: /keep\s+skills\/goal\/SKILL\.md \(content read failed — refusing\)/ },
  ];
  for (const row of rows) {
    const { base, cfg, run } = makeGoalFixture('oc-goal-unreadable-');
    try {
      writeGoalPair(cfg);
      writeGoalAllowConfig(cfg);
      // The faulted skill is the FIRST prior entry; the command behind it has
      // no recorded hash, so the next iteration keeps it as adopter-owned. Its
      // log line is the proof the sweep continued after the refusal. Keeping
      // both halves also keeps the doctor's 1:1 law clean, so exit 0 is the
      // installer's own verdict — not a masked doctor finding.
      writePriorJournal(cfg, [
        { path: 'skills/goal/SKILL.md', hash: sha256Text(GOAL_SKILL_TEXT), action: 'written' },
        { path: 'commands/goal.md', action: 'written' },
      ]);
      const fault = writeFsFaultInjector(base, { op: row.op, target: path.join(cfg, 'skills', 'goal', 'SKILL.md') });
      const r = run(fault);
      assert.equal(
        r.status,
        0,
        `${row.op}: a refusal must not abort the install, got exit ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`
      );
      assert.match(r.stdout || '', row.reason, `${row.op}: the log names the operation that failed`);
      assert.ok(
        !/keep\s+skills\/goal\/SKILL\.md \(no prior hash/.test(r.stdout || ''),
        `${row.op}: a failed read is never reported as the no-hash row`
      );

      assert.equal(
        readFileSync(path.join(cfg, 'skills', 'goal', 'SKILL.md'), 'utf8'),
        GOAL_SKILL_TEXT,
        `${row.op}: the skill file is kept byte-identical`
      );
      assert.deepEqual(journalFor(cfg, 'skills/goal/SKILL.md'), [], `${row.op}: the kept skill is never journaled as retired/archived`);
      assert.ok(!existsSync(legacyArchivedAt(cfg, 'skills', 'goal', 'SKILL.md')), `${row.op}: nothing was archived`);
      assert.ok(allowsOf(cfg).includes('goal'), `${row.op}: the goal allow survives — no skill ID was added`);
      assert.ok(!/dropped stale skill allows/.test(r.stdout || ''), `${row.op}: the merge dropped no allow`);

      // The sweep continued past the refusal (the later command entry is kept
      // on its own no-hash row), and staging + merge + journal all landed.
      assert.match(
        r.stdout || '',
        /keep\s+commands\/goal\.md \(no prior hash to compare/,
        `${row.op}: the next prior entry was still processed after the refusal`
      );
      assert.equal(
        readFileSync(path.join(cfg, 'commands', 'goal.md'), 'utf8'),
        GOAL_COMMAND_TEXT,
        `${row.op}: the hashless command is kept byte-identical`
      );
      assert.equal(journalFor(cfg, 'commands/loop.md')[0]?.action, 'written', `${row.op}: staging completed after the refusal`);
      assert.equal(journalFor(cfg, 'skills/loop/SKILL.md')[0]?.action, 'written', `${row.op}: the skill tree staged after the refusal`);
      assert.ok(allowsOf(cfg).includes('loop'), `${row.op}: the config merge completed after the refusal`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

// The prune filter is effect-specific: only an adopter `skill <id> allow` dies
// with a retired skill. `ask` and `deny` rows for the same ID are policy the
// adopter wrote and the installer has no claim on — they must survive while a
// concrete goal allow is dropped, which also proves goal reached retiredSkills.
test('goal retirement drops only the allow — an adopter non-allow effect (other effect rows) survives', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-goal-effect-');
  try {
    writeGoalPair(cfg);
    const ask = { action: 'skill', resource: 'goal', effect: 'ask' };
    const deny = { action: 'skill', resource: 'goal', effect: 'deny' };
    writeConfigRules(cfg, [
      { action: 'skill', resource: 'goal', effect: 'allow' },
      ask,
      deny,
    ]);
    writePriorJournal(cfg, [
      { path: 'commands/goal.md', hash: sha256Text(GOAL_COMMAND_TEXT), action: 'written' },
      { path: 'skills/goal/SKILL.md', hash: sha256Text(GOAL_SKILL_TEXT), action: 'written' },
    ]);
    const r = run();
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);

    assert.ok(!existsSync(path.join(cfg, 'skills', 'goal', 'SKILL.md')), 'the tracked goal skill is retired');
    assert.ok(!allowsOf(cfg).includes('goal'), 'the concrete goal allow is pruned — goal is in retiredSkills');
    assert.match(r.stdout || '', /dropped stale skill allows for retired skills: goal/, 'the allow prune is reported');
    const rules = permsOf(cfg);
    assert.ok(rules.some((p) => JSON.stringify(p) === JSON.stringify(ask)), 'the adopter ask row for the retired skill survives');
    assert.ok(rules.some((p) => JSON.stringify(p) === JSON.stringify(deny)), 'the adopter deny row for the retired skill survives');
    assert.equal(journalFor(cfg, 'commands/loop.md')[0]?.action, 'written', 'the install completed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// `skill *` is not a skill ID: the merge's prune must never read the adopter's
// wildcard allow as "the retired skill's allow" and delete it. A concrete goal
// allow in the same config is still pruned, so the exclusion is pinned against
// a filter that is demonstrably firing.
test('goal retirement keeps the adopter skill * wildcard allow', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const { base, cfg, run } = makeGoalFixture('oc-goal-wildcard-');
  try {
    writeGoalPair(cfg);
    const wildcard = { action: 'skill', resource: '*', effect: 'allow' };
    writeConfigRules(cfg, [wildcard, { action: 'skill', resource: 'goal', effect: 'allow' }]);
    writePriorJournal(cfg, [
      { path: 'commands/goal.md', hash: sha256Text(GOAL_COMMAND_TEXT), action: 'written' },
      { path: 'skills/goal/SKILL.md', hash: sha256Text(GOAL_SKILL_TEXT), action: 'written' },
    ]);
    const r = run();
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);

    assert.ok(!existsSync(path.join(cfg, 'skills', 'goal', 'SKILL.md')), 'the tracked goal skill is retired');
    assert.ok(!allowsOf(cfg).includes('goal'), 'the concrete goal allow is pruned — goal is in retiredSkills');
    assert.ok(allowsOf(cfg).includes('*'), 'the wildcard allow is kept — the wildcard is not a retired skill ID');
    assert.ok(permsOf(cfg).some((p) => JSON.stringify(p) === JSON.stringify(wildcard)), 'the adopter wildcard rule is byte-identical');
    const dropped = (r.stdout || '').match(/dropped stale skill allows for retired skills: ([^\r\n]*)/);
    assert.equal(dropped?.[1], 'goal', 'only goal is reported as dropped — the wildcard is not a retired skill ID');
    assert.equal(journalFor(cfg, 'commands/loop.md')[0]?.action, 'written', 'the install completed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------- test 6: package audit ---------------- */

test('package audit: files list exists, no leaks, 10/6/6 with 1:1 seam', { skip: WIN_SKIP }, () => {
  const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'files list present');

  const shipped = [];
  for (const entry of pkg.files) {
    const p = path.join(PKG_ROOT, entry);
    assert.ok(existsSync(p), `shipped path exists: ${entry}`);
    if (statSync(p).isDirectory()) shipped.push(...walkFiles(p));
    else shipped.push(p);
  }
  assert.ok(!shipped.some((p) => p.includes(`${path.sep}test${path.sep}`)), 'test/ is not shipped');
  assert.ok(!pkg.files.includes('test') && !pkg.files.includes('CONTRIBUTING.md'), 'test/ and CONTRIBUTING.md not in files');

  // Generic shapes only — no concrete machine, no real session, no model ids.
  const leakTests = [
    { label: 'absolute user path', test: /[a-z]:[\\/]users[\\/]/i },
    { label: 'ses_<id>', test: /ses_[a-z0-9]{16,}/ },
    { label: 'opencode-go', test: /opencode-go/ },
    { label: 'muse-spark', test: /muse-spark/ },
    { label: 'gpt-6.1-sol', test: /gpt-6\.1-sol/ },
    { label: 'deepseek', test: /deepseek/ },
  ];
  const hits = [];
  for (const f of shipped) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const pat of leakTests) {
      if (pat.test.test(text)) hits.push(`${path.relative(PKG_ROOT, f)}: ${pat.label}`);
    }
  }
  assert.deepEqual(hits, [], `leak markers in shipped content: ${hits.join('; ')}`);

  const agentIds = readdirSync(path.join(PKG_ROOT, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.deepEqual([...agentIds].sort(), [...EXPECTED_AGENTS].sort(), `${EXPECTED_AGENTS.length} agents with public names`);
  const skillDirs = readdirSync(path.join(PKG_ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(PKG_ROOT, 'skills', e.name, 'SKILL.md')))
    .map((e) => e.name);
  assert.equal(skillDirs.length, 6, `6 skills (saw ${skillDirs.length})`);
  const commandIds = readdirSync(path.join(PKG_ROOT, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.equal(commandIds.length, 6, `6 commands (saw ${commandIds.length})`);
  assert.deepEqual([...commandIds].sort(), [...skillDirs].sort(), 'commands and skills are 1:1');

  // OpenCode 2.2.0 config shape, pinned statically so a 2.1-shaped key goes red
  // without needing a host on PATH. The live proof (host parses the emitted
  // config and drops nothing) is test/host-schema.test.js.
  //   2.2.0 truth: `plugins` is the canonical array of specifier STRINGS;
  //   `permission`/`plugin` singular are the 1.x dialect the host migrates;
  //   `permissions` is an array of {action, resource, effect}; `policies`
  //   entries are filtered by a known action enum (unknown → dropped), so
  //   `tool.use` is the only action this package may emit.
  const shippedConfig = parseJsoncForTest(readFileSync(path.join(PKG_ROOT, 'opencode.jsonc'), 'utf8'));
  for (const legacy of ['plugin', 'permission', 'mcpServers', 'mcp_servers']) {
    assert.ok(!(legacy in shippedConfig), `opencode.jsonc emits no 1.x \`${legacy}\` key`);
  }
  assert.ok(
    !('plugins' in shippedConfig) || shippedConfig.plugins.every((e) => typeof e === 'string'),
    'every shipped plugins[] entry is a 2.2.0 specifier string (a 1.x tuple is dropped by the host)'
  );
  assert.ok(Array.isArray(shippedConfig.permissions), 'permissions is the 2.2.0 array shape');
  for (const rule of shippedConfig.permissions) {
    assert.deepEqual(Object.keys(rule).sort(), ['action', 'effect', 'resource'], 'permission rule carries exactly action/resource/effect');
    assert.ok(['allow', 'ask', 'deny'].includes(rule.effect), `permission effect is allow/ask/deny (saw ${rule.effect})`);
  }
  assert.ok(Array.isArray(shippedConfig.policies) && shippedConfig.policies.length > 0, 'policies block present');
  for (const p of shippedConfig.policies) {
    assert.equal(p.action, 'tool.use', 'policies use the tool.use action — any other action is dropped by the 2.2.0 schema');
    assert.ok(typeof p.resource === 'string' && p.resource.includes(':'), 'a tool.use policy resource is `<tool>:<glob>`');
  }
  assert.equal(shippedConfig.default_agent, 'orchestrator', 'default_agent is the 2.2.0 snake_case key');

  // T4 packaging: every path the doctor requires ships in the tarball.
  for (const entry of ['gitignore.template', 'AGENTS.md', 'opencode.jsonc', '.docs', 'state-seed', 'scripts', 'agents', 'commands', 'skills', 'reference']) {
    assert.ok(pkg.files.includes(entry), `files ships ${entry}`);
  }
  assert.ok(!pkg.files.includes('.gitignore'), 'files does not ship a root .gitignore (npm would rename it to .npmignore)');
  const unwiredPath = path.join(PKG_ROOT, '.docs', 'unwired-routing.md');
  assert.ok(existsSync(unwiredPath), '.docs/unwired-routing.md exists');
  const unwiredText = readFileSync(unwiredPath, 'utf8');
  assert.ok(/\bunwire[a-z]*\b[^.]{0,40}\bmodel\b|\bmodel\b[^.]{0,40}\bunwired\b/is.test(unwiredText), 'unwired-routing record names the unwired model state');
});

/* ---------------- packed-tarball install (no dotfile rename) ---------------- */

test('a packed tarball installs and passes the doctor (no dotfile rename)', { skip: WIN_SKIP, timeout: 300000 }, () => {
  // On Windows npm is an .cmd shim CreateProcess cannot launch directly
  // (spawnSync('npm') → ENOENT, spawnSync('npm.cmd') → EINVAL), so npm runs
  // through the shell as one quoted command string.
  const q = (a) => `"${String(a).replace(/"/g, '""')}"`;
  const npmSync = (args, opts = {}) => spawnSync(`npm ${args.map(q).join(' ')}`, { encoding: 'utf8', shell: true, ...opts });
  const npmProbe = npmSync(['--version']);
  if (npmProbe.error || npmProbe.status !== 0) {
    console.log('SKIP: npm not runnable — packed-tarball test needs npm; skipping');
    return;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'oc-pack-'));
  let cfg = null;
  try {
    const pack = npmSync(['pack', '--json', '--pack-destination', tmp], { cwd: PKG_ROOT });
    assert.equal(pack.status, 0, `npm pack exit was ${pack.status}\nSTDOUT:\n${pack.stdout}\nSTDERR:\n${pack.stderr}`);
    const parsed = JSON.parse(pack.stdout || 'null');
    // `npm pack --json` prints an array on some versions and a
    // name-keyed object on others — either way, take entry zero.
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
    assert.ok(entries.length > 0 && entries[0].filename, 'npm pack --json names the tarball');
    const tgz = path.join(tmp, entries[0].filename);
    assert.ok(existsSync(tgz), `tarball exists: ${tgz}`);

    assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())), 'tmp stays under os.tmpdir()');
    const inst = path.join(tmp, 'inst');
    mkdirSync(inst, { recursive: true });
    const installed = npmSync(
      ['install', '--prefix', inst, '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tgz],
      { cwd: tmp }
    );
    assert.equal(installed.status, 0, `npm install exit was ${installed.status}\nSTDOUT:\n${installed.stdout}\nSTDERR:\n${installed.stderr}`);

    const installedRoot = path.join(inst, 'node_modules', 'oc-harness-setup');
    assert.ok(existsSync(path.join(installedRoot, 'gitignore.template')), 'installed copy ships gitignore.template');
    assert.ok(!existsSync(path.join(installedRoot, '.gitignore')), 'installed copy has no root .gitignore (npm rename pinned)');

    const v = spawnSync(process.execPath, [path.join(installedRoot, 'bin', 'cli.js'), '--version'], { encoding: 'utf8' });
    assert.equal(v.status, 0, `installed --version exit was ${v.status}: ${v.stderr}`);
    assert.equal((v.stdout || '').trim(), EXPECTED_VERSION);

    cfg = mkdtempSync(path.join(os.tmpdir(), 'oc-pack-cfg-'));
    assert.ok(path.resolve(cfg).startsWith(path.resolve(os.tmpdir())), 'cfg stays under os.tmpdir() — never the real config');
    const fakeBin = path.join(tmp, 'fakebin');
    mkdirSync(fakeBin, { recursive: true });
    writeFakeOpencode(fakeBin);
    const r = spawnSync(process.execPath, [path.join(installedRoot, 'bin', 'cli.js'), 'setup'], {
      encoding: 'utf8',
      input: 'y\n',
      cwd: cfg,
      env: {
        ...process.env,
        OPENCODE_CONFIG_DIR: cfg,
        FAKE_OPENCODE_CONFIG: cfg,
        PATH: fakePath(fakeBin),
      },
    });
    assert.equal(r.status, 0, `installed setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
    assert.ok(existsSync(path.join(cfg, '.gitignore')), 'installed setup writes <cfg>/.gitignore');
    assert.ok(!(r.stdout || '').includes('[FAIL]'), 'installed setup passes the doctor with no [FAIL]');
    assert.ok((r.stdout || '').includes(cfg), 'installed setup logs the literal <cfg> path');

    const installedCli = path.join(installedRoot, 'bin', 'cli.js');
    // This test must never run the installer against the user's real
    // `~\.config\opencode`: every run below re-asserts the tmpdir guard and
    // the fake-opencode PATH before spawning the installed CLI.
    const packEnv = () => {
      assert.ok(path.resolve(cfg).startsWith(path.resolve(os.tmpdir())), 'cfg stays under os.tmpdir() — never the real config');
      return {
        ...process.env,
        OPENCODE_CONFIG_DIR: cfg,
        FAKE_OPENCODE_CONFIG: cfg,
        PATH: fakePath(fakeBin),
      };
    };

    // 1. Re-run idempotence with the SAME installed CLI, SAME cfg, SAME env.
    const rerun = spawnSync(process.execPath, [installedCli, 'setup'], {
      encoding: 'utf8',
      input: 'y\n',
      cwd: cfg,
      env: packEnv(),
    });
    assert.equal(rerun.status, 0, `re-run setup exit was ${rerun.status}\nSTDOUT:\n${rerun.stdout}\nSTDERR:\n${rerun.stderr}`);
    assert.ok((rerun.stdout || '').includes('0 new'), 're-run stages nothing new (incoming files : N (0 new, …))');
    assert.ok(!(rerun.stdout || '').includes('[FAIL]'), 're-run passes the doctor with no [FAIL]');
    assert.ok(existsSync(path.join(cfg, '.gitignore')), 're-run keeps <cfg>/.gitignore');

    // 2. Uninstall with the SAME installed CLI, SAME cfg, SAME env.
    appendFileSync(path.join(cfg, 'state', 'lessons.md'), '\n- lifecycle note: adopter edit\n');
    const un = spawnSync(process.execPath, [installedCli, 'setup', '--uninstall'], {
      encoding: 'utf8',
      cwd: cfg,
      env: packEnv(),
    });
    assert.equal(un.status, 0, `uninstall exit was ${un.status}\nSTDOUT:\n${un.stdout}\nSTDERR:\n${un.stderr}`);
    for (const rel of ['skills/loop/SKILL.md', 'commands/loop.md', 'AGENTS.md', '.gitignore']) {
      assert.ok(!existsSync(path.join(cfg, rel)), `uninstall removed ${rel}`);
    }
    assert.ok(existsSync(path.join(cfg, 'state', 'lessons.md')), 'adopter-owned state/lessons.md preserved across uninstall');
    assert.ok(readFileSync(path.join(cfg, 'state', 'lessons.md'), 'utf8').includes('lifecycle note: adopter edit'), 'adopter-edited state/lessons.md kept with the adopter edit');
    assert.ok(!existsSync(path.join(cfg, 'oc-harness-setup.manifest.json')), 'uninstall removed the manifest');

    // 3. Reinstall with the SAME installed CLI, SAME cfg, SAME env.
    const re = spawnSync(process.execPath, [installedCli, 'setup'], {
      encoding: 'utf8',
      input: 'y\n',
      cwd: cfg,
      env: packEnv(),
    });
    assert.equal(re.status, 0, `reinstall setup exit was ${re.status}\nSTDOUT:\n${re.stdout}\nSTDERR:\n${re.stderr}`);
    assert.ok(!(re.stdout || '').includes('[FAIL]'), 'reinstall passes the doctor with no [FAIL]');
    assert.ok(existsSync(path.join(cfg, 'AGENTS.md')), 'reinstall restores AGENTS.md');
    assert.ok(existsSync(path.join(cfg, '.gitignore')), 'reinstall restores <cfg>/.gitignore');
    assert.ok(readFileSync(path.join(cfg, 'state', 'lessons.md'), 'utf8').includes('lifecycle note: adopter edit'), 'reinstall preserves the adopter edit in state/lessons.md');
    assert.ok((re.stdout || '').includes('harness-doctor passed'), 'reinstall doctor line shows a pass (harness-doctor passed)');
  } finally {
    if (cfg) {
      // The installer snapshots the config dir to `<cfg>.bak-oc-harness-setup-<stamp>`
      // BESIDE it, so removing `cfg` alone leaks one snapshot per run. Sweep only
      // this fixture's own sibling snapshots (name-prefixed), never the temp root.
      const parent = path.dirname(cfg);
      const prefix = `${path.basename(cfg)}.bak-oc-harness-setup-`;
      for (const name of readdirSync(parent)) {
        if (name.startsWith(prefix)) rmSync(path.join(parent, name), { recursive: true, force: true });
      }
      rmSync(cfg, { recursive: true, force: true });
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
