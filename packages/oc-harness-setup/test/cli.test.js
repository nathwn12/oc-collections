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
 * Doctor tests skip with a clear message when `pwsh` is absent.
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
const EXPECTED_VERSION = '0.4.4';
const EXPECTED_AGENTS = ['orchestrator', 'worker', 'verifier', 'researcher', 'ops', 'critic', 'historian', 'cleaner', 'maintainer'];
const EXPECTED_SKILLS = ['close', 'evolve', 'fast', 'goal', 'search', 'swarm'];

const sha256Text = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function runCli(args, { env = {}, input, cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input,
    cwd,
    env: { ...process.env, ...env },
  });
}

function pwshUsable() {
  try {
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
    return !(r.error || r.status !== 0);
  } catch {
    return false;
  }
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
    path.join(cfg, 'scripts', 'harness-doctor.ps1'),
    readFileSync(path.join(PKG_ROOT, 'scripts', 'harness-doctor.ps1'), 'utf8')
  );
  return cfg;
}

function runDoctorScript(cfg) {
  const script = path.join(cfg, 'scripts', 'harness-doctor.ps1');
  return spawnSync('pwsh', ['-NoProfile', '-File', script, '-ConfigDir', cfg], { encoding: 'utf8' });
}

function runDoctorPwsh(cfg) {
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

test('--version prints 0.4.4', { skip: WIN_SKIP }, () => {
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
if (a[0] === '--version') out('2.0.32');
else if (a[0] === 'debug' && a[1] === 'paths') out('config = ' + cfg);
else if (a[0] === 'debug' && a[1] === 'config') out(JSON.stringify([{ type: 'document', path: cfg + '/opencode.jsonc' }]));
else if (a[0] === 'debug' && a[1] === 'agents') out(JSON.stringify([{ name: 'orchestrator' }]));
else if (a[0] === 'plugin' && a[1] === 'list') {
  // Default: no plugins. When FAKE_OPENCODE_PLUGINS names installed plugins,
  // the registry agrees with the config — otherwise Law 6 (correctly) fails
  // a config that declares plugins the registry does not have.
  const rows = (process.env.FAKE_OPENCODE_PLUGINS ?? '').split(/[,\\s]+/).filter(Boolean);
  if (!rows.length) out('No plugins found');
  else { out('NAME          VERSION'); for (const name of rows) out(name + '  1.0.0'); }
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

test('real install upgrades a prior 0.3.3 tree (fake opencode, real pwsh)', { skip: WIN_SKIP, timeout: 300000 }, () => {
  if (!pwshUsable()) {
    console.log('SKIP: pwsh absent — install test needs the real doctor; skipping');
    return;
  }
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-install-'));
  const cfg = path.join(base, 'cfg');
  mkdirSync(cfg, { recursive: true });
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFakeOpencode(fakeBin);

  // Prior 0.3.3 tree: stale pack files + a STOCK AGENTS.md (hash matches).
  const oldAgents = '# old AGENTS contract\n';
  const oldSkill = '---\nname: old\ndescription: old skill\n---\n';
  const editedX = '---\nname: edited\ndescription: edited skill v1\n---\n';
  const editedY = '---\nname: edited\ndescription: edited skill v2, adopter-modified\n---\n';
  const orchX = '# old orchestrator primary v1\n';
  const orchZ = '# old orchestrator primary, adopter-modified\n';
  const priorTree = {
    'agents/build.md': '# old build agent\n',
    'agents/orchestrator.md': orchZ, // on disk: user-edited (differs from manifest hash X)
    'commands/build.md': '# old build command\n',
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
    // orchestrator journals hash X while the disk holds Z.
    const hash = rel === 'skills/edited/SKILL.md' ? sha256Text(editedX)
      : rel === 'agents/orchestrator.md' ? sha256Text(orchX)
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

  // 9 agents ship; orchestrator carries steps: 40 and no model pin.
  const agentIds = readdirSync(path.join(cfg, 'agents')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.deepEqual([...agentIds].sort(), [...EXPECTED_AGENTS].sort(), '9 agents installed');
  const orch = readFileSync(path.join(cfg, 'agents', 'orchestrator.md'), 'utf8');
  assert.ok(orch.includes('steps: 40'), 'orchestrator carries steps: 40');
  assert.ok(!/^model:/m.test(orch), 'orchestrator carries no model: line');

  // 6 skills + 6 commands land, 12 refs, state files, GLOSSARY.
  const skillDirs = readdirSync(path.join(cfg, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_shared')
    .map((e) => e.name);
  assert.deepEqual([...skillDirs].sort(), [...EXPECTED_SKILLS].sort(), '6 skills installed');
  const commandIds = readdirSync(path.join(cfg, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.deepEqual([...commandIds].sort(), [...EXPECTED_SKILLS].sort(), '6 commands installed');
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

  // User-edited incoming file: the active orchestrator is the new public
  // content, and the adopter's bytes survive in the runtime archive.
  const publicOrch = readFileSync(path.join(PKG_ROOT, 'agents', 'orchestrator.md'), 'utf8');
  assert.equal(readFileSync(path.join(cfg, 'agents', 'orchestrator.md'), 'utf8'), publicOrch, 'active orchestrator is the new public content');
  const orchArchived = path.join(cfg, 'state', 'archive', 'legacy-0.3.x', 'agents', 'orchestrator.md');
  assert.ok(existsSync(orchArchived), 'edited orchestrator archived under state/archive/legacy-0.3.x/');
  assert.equal(readFileSync(orchArchived, 'utf8'), orchZ, 'orchestrator archive holds the user-edited bytes');

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
  assert.deepEqual(retired, ['agents/build.md', 'commands/build.md', 'reference/old.md', 'scripts/old.ps1', 'skills/old/SKILL.md'].sort());
  const archivedEntries = manifest.files.filter((f) => f.action === 'archived');
  assert.equal(archivedEntries.length, 1, 'one archived journal entry');
  assert.equal(archivedEntries[0].path, 'skills/edited/SKILL.md', 'archived entry names the edited skill');
  assert.ok(String(archivedEntries[0].archivedTo || '').length > 0, 'archived entry records archivedTo');
  const orchEntry = manifest.files.find((f) => String(f.path).replace(/\\/g, '/') === 'agents/orchestrator.md');
  assert.ok(orchEntry, 'orchestrator has a journal entry');
  assert.equal(orchEntry.action, 'overwritten', 'edited incoming file journals overwritten');
  assert.ok(String(orchEntry.archivedTo || '').length > 0, 'orchestrator entry records archivedTo');

  // Separator-normalization pin: a second run sees orchestrator as identical
  // (skip) but must carry forward the earlier overwritten truth, even though
  // the prior manifest spelled paths with forward slashes. Otherwise
  // --uninstall would delete the file instead of restoring the pre-install
  // original from backup.
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
  const orchEntry2 = manifest2.files.find((f) => String(f.path).replace(/\\/g, '/') === 'agents/orchestrator.md');
  assert.ok(orchEntry2, 'orchestrator still has a journal entry after a second run');
  assert.equal(orchEntry2.action, 'overwritten', 'second run did not downgrade overwritten to skip');
  assert.ok(String(orchEntry2.prevHash || orchEntry2.archivedTo || '').length > 0, 'second run kept prevHash or archivedTo');

  shared.cfg = cfg;
  shared.env = env;
  shared.oldAgents = oldAgents;
  shared.oldBuildAgent = priorTree['agents/build.md'];
  shared.editedY = editedY;
  shared.orchZ = orchZ;
});

/* ---------------- 0.4.x plugin residue + template archive + same-version re-run ---------------- */

test('0.4.x upgrade drops plugin residue, archives an edited template, and keeps a re-added plugin on a same-version re-run', { skip: WIN_SKIP, timeout: 300000 }, () => {
  const shippedTemplate = readFileSync(path.join(PKG_ROOT, 'state-seed', 'template.md'), 'utf8');
  const originalBytes = '# original template v0.4.1\n';
  const editedBytes = '# adopter-edited template — must be archived, not lost\n';
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
    assert.equal(readFileSync(path.join(cfgA, 'state', 'template.md'), 'utf8'), shippedTemplate, 'template is replaced by the shipped bytes');
    const archivedA = path.join(cfgA, 'state', 'archive', 'legacy-0.3.x', 'state', 'template.md');
    assert.ok(existsSync(archivedA), 'edited template archived under state/archive/legacy-0.3.x/state/template.md');
    assert.equal(readFileSync(archivedA, 'utf8'), editedBytes, 'archive holds the EDITED bytes');
  } finally {
    rmSync(baseA, { recursive: true, force: true });
  }

  // Fixture B: same-version re-run keeps a deliberately re-added plugin.
  const baseB = mkdtempSync(path.join(os.tmpdir(), 'oc-04x-b-'));
  const cfgB = path.join(baseB, 'cfg');
  mkdirSync(path.join(cfgB, 'state'), { recursive: true });
  const fakeBinB = path.join(baseB, 'fakebin');
  mkdirSync(fakeBinB, { recursive: true });
  writeFakeOpencode(fakeBinB);
  writeFileSync(path.join(cfgB, 'opencode.jsonc'), JSON.stringify({ model: 'keep-me', plugins: ['oc-flight-deck', 'adopter-plugin'] }, null, 2));
  writeFileSync(path.join(cfgB, 'state', 'template.md'), editedBytes);
  writeFileSync(path.join(cfgB, 'oc-harness-setup.manifest.json'), JSON.stringify({
    package: 'oc-harness-setup', version: '0.4.4', created: new Date().toISOString(),
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
        FAKE_OPENCODE_PLUGINS: 'oc-flight-deck adopter-plugin',
        PATH: fakePath(fakeBinB),
      },
      input: 'y\n',
      cwd: cfgB,
    });
    assert.equal(rB.status, 0, `fixture B setup exit was ${rB.status}\nSTDOUT:\n${rB.stdout}\nSTDERR:\n${rB.stderr}`);
    const mergedB = JSON.parse(stripLineComments(readFileSync(path.join(cfgB, 'opencode.jsonc'), 'utf8')));
    assert.ok((mergedB.plugins || []).includes('oc-flight-deck'), 'same-version re-run keeps the re-added distro plugin');
    assert.ok((mergedB.plugins || []).includes('adopter-plugin'), 'same-version re-run keeps the adopter plugin');
  } finally {
    rmSync(baseB, { recursive: true, force: true });
  }
});

/* ---------------- test 5 (before uninstall): negative doctor ---------------- */

test('doctor fails naming state/template.md when it is removed', { skip: WIN_SKIP, timeout: 120000 }, () => {
  if (!pwshUsable()) {
    console.log('SKIP: pwsh absent — cannot run harness-doctor; skipping');
    return;
  }
  if (!shared.cfg) {
    console.log('SKIP: install test was skipped — nothing to grade; skipping');
    return;
  }
  rmSync(path.join(shared.cfg, 'state', 'template.md'), { force: true });
  const script = path.join(shared.cfg, 'scripts', 'harness-doctor.ps1');
  const r = spawnSync('pwsh', ['-NoProfile', '-File', script, '-ConfigDir', shared.cfg], { encoding: 'utf8' });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  assert.notEqual(r.status, 0, `doctor should fail without state/template.md:\n${out}`);
  assert.ok(out.includes('state/template.md'), 'a law failure names the missing path');
});

/* ---------------- T1: doctor grades a config with no permissions key ---------------- */

test('doctor grades a config with no permissions key instead of crashing', { skip: WIN_SKIP, timeout: 120000 }, () => {
  if (!pwshUsable()) {
    console.log('SKIP: pwsh absent — cannot run harness-doctor; skipping');
    return;
  }
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-noperms-'));
  try {
    const cfg = makeDoctorFixture(base, { default_agent: 'orchestrator' });
    const { status, out } = runDoctorPwsh(cfg);
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
  if (!pwshUsable()) {
    console.log('SKIP: pwsh absent — cannot run harness-doctor; skipping');
    return;
  }
  const distroPerms = parseJsoncForTest(readFileSync(path.join(PKG_ROOT, 'opencode.jsonc'), 'utf8')).permissions;
  const baseA = mkdtempSync(path.join(os.tmpdir(), 'oc-doctor-pointer-'));
  try {
    const cfgA = makeDoctorFixture(baseA, {
      default_agent: 'orchestrator',
      permissions: distroPerms,
      provider: { openai: { options: { apiKey: '{env:OPENAI_API_KEY}' } } },
    });
    const { out } = runDoctorPwsh(cfgA);
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
    const { status, out } = runDoctorPwsh(cfgB);
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

  // Harness files are gone (orchestrator is an overwritten entry, so it is
  // restored from backup below — not removed).
  for (const rel of ['skills/goal/SKILL.md', 'commands/goal.md']) {
    assert.ok(!existsSync(path.join(shared.cfg, rel)), `${rel} removed`);
  }

  // Pre-install originals come back from the backup.
  assert.equal(readFileSync(path.join(shared.cfg, 'AGENTS.md'), 'utf8'), shared.oldAgents, 'original AGENTS.md restored');
  assert.equal(readFileSync(path.join(shared.cfg, 'agents', 'build.md'), 'utf8'), shared.oldBuildAgent, 'retired file restored from backup');
  assert.equal(readFileSync(path.join(shared.cfg, 'skills', 'edited', 'SKILL.md'), 'utf8'), shared.editedY, 'archived file restored from backup (pre-install bytes Y)');
  assert.equal(readFileSync(path.join(shared.cfg, 'agents', 'orchestrator.md'), 'utf8'), shared.orchZ, 'edited incoming file restored from backup (pre-install bytes Z)');
  const restoredConfig = JSON.parse(stripLineComments(readFileSync(path.join(shared.cfg, 'opencode.jsonc'), 'utf8')));
  assert.equal(restoredConfig.model, 'keeper-model', 'adopter opencode.jsonc restored');
  assert.ok(!('default_agent' in restoredConfig), 'harness default_agent gone after restore');
});

/* ---------------- test 6: package audit ---------------- */

test('package audit: files list exists, no leaks, 9/6/6 with 1:1 seam', { skip: WIN_SKIP }, () => {
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
  assert.deepEqual([...agentIds].sort(), [...EXPECTED_AGENTS].sort(), '9 agents with public names');
  const skillDirs = readdirSync(path.join(PKG_ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(PKG_ROOT, 'skills', e.name, 'SKILL.md')))
    .map((e) => e.name);
  assert.equal(skillDirs.length, 6, `6 skills (saw ${skillDirs.length})`);
  const commandIds = readdirSync(path.join(PKG_ROOT, 'commands')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  assert.equal(commandIds.length, 6, `6 commands (saw ${commandIds.length})`);
  assert.deepEqual([...commandIds].sort(), [...skillDirs].sort(), 'commands and skills are 1:1');

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
  if (!pwshUsable()) {
    console.log('SKIP: pwsh absent — packed-tarball test needs the real doctor; skipping');
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
    assert.equal((v.stdout || '').trim(), '0.4.4');

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
    for (const rel of ['skills/goal/SKILL.md', 'commands/goal.md', 'AGENTS.md', '.gitignore']) {
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
    if (cfg) rmSync(cfg, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
