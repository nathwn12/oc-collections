/**
 * CLI install shard: full upgrade install, 0.4.x upgrade, additive policy and
 * merge, doctor (negative, T1, T2), and uninstall. Owns the order-sensitive
 * shared.cfg chain: the upgrade install writes shared, the negative doctor and
 * uninstall read it, so they stay in this file in the original order.
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
