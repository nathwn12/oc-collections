/**
 * CLI /goal shard: the /goal retirement and allow-pruning matrix.
 * In-file order kept from test/cli.test.js.
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
