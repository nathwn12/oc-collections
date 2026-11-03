/**
 * CLI misc shard: version, startup guard, version gate, dry-run, package
 * audit, packed-tarball install. In-file order kept from test/cli.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CLI, EXPECTED_AGENTS, EXPECTED_SKILLS, EXPECTED_VERSION, GOAL_COMMAND_TEXT,
  GOAL_SKILL_TEXT, PKG_ROOT, WIN_SKIP, allowsOf, fakePath, journalFor,
  legacyArchivedAt, makeDoctorFixture, makeGoalFixture, parseJsoncForTest,
  permsOf, posix, runCli, runDoctorNode, sha256Text, stripLineComments,
  walkFiles, writeConfigRules, writeFakeOpencode, writeFsFaultInjector,
  writeGoalAllowConfig, writeGoalPair, writePriorJournal,
} from './helpers.js';

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
