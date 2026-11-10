/**
 * ready / scope / check / clean: GO and NO-GO, forged records, the gate's
 * memory, and the five sections a report must actually have.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkRecordReasons } from '../../lib/tools.js';

export async function register(ctx) {
  const { check, checkAsync, assert, tmpRepo, commitAll, configuredRepo, runIn } = ctx;

  // The live-seam fixture every gate assertion walks: one committed check, one
  // brief, then a tree that gets dirtied, checked, reported, and landed.
  const dir = configuredRepo();
  await runIn(dir, 'brief', {
    op: 'new', agent: 'backend',
    title: 'retry budget',
    out: 'a failing endpoint is retried at most three times',
    check: 'node -e "process.exit(0)"',
    owns: ['src/**', '.stack/**'],
    why: 'production retries never stop',
    tier: 'standard',
  });

  await checkAsync('check init detects nothing and says so honestly', async () => {
    const emptyDir = tmpRepo();
    const out = await runIn(emptyDir, 'check', { op: 'init' });
    assert(/no check could be detected/i.test(out), `unexpected: ${out.slice(0, 160)}`);
    const cfg = JSON.parse(fs.readFileSync(path.join(emptyDir, '.stack', 'config.json'), 'utf8'));
    assert(Array.isArray(cfg.checks) && cfg.checks.length === 0, 'config was not written with an empty list');
    fs.rmSync(emptyDir, { recursive: true, force: true });
    return 'empty list, UNPROVEN';
  });

  await checkAsync('check runs a configured command and binds it to HEAD', async () => {
    const out = await runIn(dir, 'check', { op: 'run' });
    assert(/GREEN/.test(out), `expected GREEN, got: ${out.slice(0, 160)}`);
    const record = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'checks.json'), 'utf8'));
    assert(record.results[0].ok === true, 'result not recorded as ok');
    assert('head' in record, 'record is not bound to a HEAD');
    assert(out.includes('node -e'), 'the command itself is not printed, so nobody can audit it');
    return 'GREEN at HEAD, command printed';
  });

  await checkAsync('check reports RED, not green, on a failing command', async () => {
    const redDir = tmpRepo();
    fs.mkdirSync(path.join(redDir, '.stack'), { recursive: true });
    fs.writeFileSync(
      path.join(redDir, '.stack', 'config.json'),
      JSON.stringify({ checks: [{ name: 'broken', command: 'node -e "process.exit(3)"', timeout: 30000 }] }, null, 2),
    );
    const out = await runIn(redDir, 'check', { op: 'run' });
    assert(/RED/.test(out) && !/GREEN/.test(out), `a failing command was not called RED: ${out.slice(0, 160)}`);
    fs.rmSync(redDir, { recursive: true, force: true });
    return 'exit 3 → RED';
  });

  await checkAsync('scope names what left the brief', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'webhook.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'outside.ts'), 'export const y = 1;\n');
    const out = await runIn(dir, 'scope', { id: 'retry-budget' });
    assert(/OUT/.test(out), 'an out-of-bounds path was not flagged');
    assert(out.includes('outside.ts'), 'the out-of-bounds file is not named');
    assert(!/OUT.*webhook\.ts/.test(out), 'an in-bounds file was wrongly flagged');
    return 'outside.ts flagged';
  });

  await checkAsync('ready is NO-GO while the tree is dirty, and names why', async () => {
    const out = await runIn(dir, 'ready', { id: 'retry-budget' });
    assert(/NO-GO/.test(out), 'a dirty tree was gated GO');
    assert(/report missing|uncommitted|RED/i.test(out), 'no reason was named');
    return out.split('\n')[0].replace('## ', '');
  });

  await checkAsync('ready is NO-GO with no report even when the check is green', async () => {
    await runIn(dir, 'check', { op: 'run' });
    const out = await runIn(dir, 'ready', { id: 'retry-budget' });
    assert(/NO-GO/.test(out), 'a seam with no report was gated GO');
    assert(/report missing/i.test(out), 'the missing report was not named');
    return 'report is not optional';
  });

  await checkAsync('ready turns GO only when nothing is left to verify', async () => {
    // Commit everything, write the report, prove the check at the new HEAD.
    fs.writeFileSync(path.join(dir, '.stack', 'reports', 'retry-budget.md'), [
      '# retry budget',
      '',
      '## Outcome',
      '',
      'Retries stop at three.',
      '',
      '## Evidence',
      '',
      '`node -e "process.exit(0)"` exit 0.',
      '',
      '## Unverified',
      '',
      'none',
      '',
      '## Scope',
      '',
      '`src/webhook.ts` only.',
      '',
      '## Lesson',
      '',
      'A counter that resets is not a counter.',
      '',
    ].join('\n'));
    // Make the brief's Owns cover everything actually touched.
    const briefFile = path.join(dir, '.stack', 'briefs', 'retry-budget.md');
    fs.writeFileSync(briefFile, fs.readFileSync(briefFile, 'utf8').replace('- `src/**`', '- `src/**`\n- `outside.ts`'));
    const index = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'briefs.json'), 'utf8'));
    index[0].owns = ['src/**', 'outside.ts', '.stack/**'];
    fs.writeFileSync(path.join(dir, '.stack', 'state', 'briefs.json'), JSON.stringify(index, null, 2));

    spawnSync('git', ['add', '-A'], { cwd: dir, windowsHide: true });
    spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'retry budget'], {
      cwd: dir,
      windowsHide: true,
    });
    await runIn(dir, 'check', { op: 'run' });
    const out = await runIn(dir, 'ready', { id: 'retry-budget' });
    assert(/## GO\b/.test(out), `expected GO, got:\n${out}`);
    return 'GO on committed, checked, reported work';
  });

  await checkAsync('ready re-runs the checks at the head it gates', async () => {
    const before = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'checks.json'), 'utf8')).head;
    fs.writeFileSync(path.join(dir, 'src', 'webhook.ts'), 'export const x = 2;\n');
    commitAll(dir, 'move head');
    const out = await runIn(dir, 'ready', { id: 'retry-budget' });
    assert(/## GO\b/.test(out), `expected GO after a green re-run at the new HEAD, got:\n${out}`);
    const now = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
    const after = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'checks.json'), 'utf8'));
    assert(after.head === now, `the gate did not re-run the check at HEAD (${after.head} vs ${now})`);
    assert(before !== now, 'the head did not actually move, so this proves nothing');
    return 're-ran at the new head';
  });

  await checkAsync('marking a seam landed without a GO is refused', async () => {
    await runIn(dir, 'brief', {
      op: 'new', agent: 'backend',
      title: 'no gate yet',
      out: 'something nobody proved',
      check: 'node -e "process.exit(0)"',
      owns: ['notes/**'],
      files: ['notes/plan.md'],
    });
    const out = await runIn(dir, 'brief', { op: 'status', id: 'no-gate-yet', status: 'landed' });
    assert(/Refused/.test(out), 'a seam landed with no gate at all');
    assert(/no gate has run|cannot be marked landed/i.test(out), 'the reason was not named');
    const index = JSON.parse(fs.readFileSync(path.join(dir, '.stack', 'state', 'briefs.json'), 'utf8'));
    assert(index.find((b) => b.id === 'no-gate-yet').status === 'briefed', 'the status changed anyway');
    return 'status unchanged';
  });

  await checkAsync('landing after a NO-GO is refused, and force records why', async () => {
    // The gate must log a RED for this seam before we can prove the landing gate
    // reads it. A dirty tree is the cheapest honest way to be refused.
    fs.writeFileSync(path.join(dir, 'src', 'uncommitted.ts'), 'export const z = 1;\n');
    const gate = await runIn(dir, 'ready', { id: 'retry-budget' });
    assert(/NO-GO/.test(gate), `the dirty tree was gated GO:\n${gate}`);
    const refused = await runIn(dir, 'brief', { op: 'status', id: 'retry-budget', status: 'landed' });
    assert(/Refused/.test(refused), 'a NO-GO seam was marked landed');
    assert(/RED/.test(refused), 'the last verdict was not quoted');
    fs.rmSync(path.join(dir, 'src', 'uncommitted.ts'), { force: true });
    const forced = await runIn(dir, 'brief', { op: 'status', id: 'retry-budget', status: 'landed', force: true });
    assert(/landed/.test(forced), 'force did not work');
    const tail = await runIn(dir, 'ledger', { op: 'tail', limit: 6 });
    assert(/without a GO/.test(tail), 'the forced landing left no ruling in the ledger');
    return 'refused, then forced with a ruling';
  });

  // ---------------------------------------------------------------- the gate's memory
  await checkAsync('a commit outside the seam is caught after the tree is clean', async () => {
    const d = tmpRepo();
    fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
    fs.writeFileSync(
      path.join(d, '.stack', 'config.json'),
      JSON.stringify({ checks: [{ name: 'ok', command: 'node -e "process.exit(0)"', timeout: 30000 }] }, null, 2),
    );
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'a.ts'), 'export const a = 1;\n');
    const commit = (m) => {
      spawnSync('git', ['add', '-A'], { cwd: d, windowsHide: true });
      spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', m], { cwd: d, windowsHide: true });
    };
    commit('base');

    await runIn(d, 'brief', {
      op: 'new', agent: 'backend',
      title: 'only a',
      out: 'a changes',
      check: 'node -e "process.exit(0)"',
      owns: ['src/a.ts'],
      files: ['src/a.ts'],
    });

    // The seam is briefed; now commit something it never claimed.
    fs.writeFileSync(path.join(d, 'src', 'b.ts'), 'export const b = 1;\n');
    commit('sneak b in');
    await runIn(d, 'check', { op: 'run' });

    const out = await runIn(d, 'ready', { id: 'only-a', lean: true });
    assert(/NO-GO/.test(out), `a committed file outside the seam was gated GO:\n${out}`);
    assert(/src\/b\.ts/.test(out), `the out-of-seam commit was not named:\n${out}`);

    // Widen the brief honestly and the same gate passes.
    const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    index[0].files = ['src/a.ts', 'src/b.ts'];
    index[0].owns = ['src/a.ts', 'src/b.ts'];
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    const widened = await runIn(d, 'ready', { id: 'only-a', lean: true });
    assert(/## GO/.test(widened), `a widened brief did not pass:\n${widened}`);

    fs.rmSync(d, { recursive: true, force: true });
    return 'caught after commit, then GO when widened';
  });

  await checkAsync('editing the check config mid-seam is a finding, not a pass', async () => {
    const d = tmpRepo();
    fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
    const cfg = (cmd) => JSON.stringify({ checks: [{ name: 'ok', command: cmd, timeout: 30000 }] }, null, 2);
    fs.writeFileSync(path.join(d, '.stack', 'config.json'), cfg('node -e "process.exit(0)"'));
    spawnSync('git', ['add', '-A'], { cwd: d, windowsHide: true });
    spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'base'], { cwd: d, windowsHide: true });

    await runIn(d, 'brief', {
      op: 'new', agent: 'backend',
      title: 'trusted check',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['notes.md'],
    });

    // The attack: make the check trivially pass, then claim green.
    fs.writeFileSync(path.join(d, '.stack', 'config.json'), cfg('node -e "process.exit(0)" // tampered'));
    await runIn(d, 'check', { op: 'run' });
    const out = await runIn(d, 'ready', { id: 'trusted-check', lean: true });
    assert(/NO-GO/.test(out), `a tampered check config was gated GO:\n${out}`);
    assert(/config\.json changed/.test(out), 'the config change was not named');

    fs.rmSync(d, { recursive: true, force: true });
    return 'config change refused';
  });

  await checkAsync('a verdict survives a ledger far past any window', async () => {
    const d = tmpRepo();
    fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
    fs.writeFileSync(
      path.join(d, '.stack', 'config.json'),
      JSON.stringify({ checks: [{ name: 'ok', command: 'node -e "process.exit(0)"', timeout: 30000 }] }, null, 2),
    );
    spawnSync('git', ['add', '-A'], { cwd: d, windowsHide: true });
    spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'base'], { cwd: d, windowsHide: true });
    await runIn(d, 'brief', {
      op: 'new', agent: 'backend',
      title: 'old gate',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['notes.md'],
    });
    await runIn(d, 'check', { op: 'run' });
    const gate = await runIn(d, 'ready', { id: 'old-gate', lean: true });
    assert(/## GO/.test(gate), `setup gate failed:\n${gate}`);

    for (let i = 0; i < 350; i += 1) await runIn(d, 'ledger', { op: 'log', kind: 'NOTE', text: `noise ${i}` });
    const landed = await runIn(d, 'brief', { op: 'status', id: 'old-gate', status: 'landed' });
    assert(!/Refused/.test(landed), `the gate forgot its own verdict after 350 entries:\n${landed}`);

    fs.rmSync(d, { recursive: true, force: true });
    return 'GO found at entry 1 of 360';
  });

  // ---------------------------------------------------------------- gate evidence, ids, atomic writes
  await checkAsync('a forged green check record is not evidence', async () => {
    const d = configuredRepo('node -e "process.exit(3)"');
    await runIn(d, 'brief', {
      op: 'new', agent: 'backend',
      title: 'forged',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['n.md'],
    });
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).stdout.trim();
    const file = path.join(d, '.stack', 'state', 'checks.json');
    const forge = (results) =>
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), head: headSha, branch: 'main', results }, null, 2));

    forge([]);
    const empty = await runIn(d, 'ready', { id: 'forged', lean: true });
    assert(/NO-GO/.test(empty), `an empty result set at HEAD was gated GO:\n${empty}`);

    forge([{ name: 'fake', command: 'node -e "process.exit(0)"', ok: true, code: 0, ms: 1, tail: '' }]);
    const forged = await runIn(d, 'ready', { id: 'forged', lean: true });
    assert(/NO-GO/.test(forged), `a hand-written green record was gated GO:\n${forged}`);
    assert(/RED/.test(forged), `the real failing check was not named:\n${forged}`);

    fs.rmSync(d, { recursive: true, force: true });
    return 'the gate runs the checks itself';
  });

  check('a check record must cover every configured check', () => {
    const all = [{ name: 'a' }, { name: 'b' }];
    const green = checkRecordReasons({ results: [{ name: 'a', ok: true }, { name: 'b', ok: true }] }, all);
    assert(!green.length, `a complete green record was refused: ${green.join('; ')}`);
    const partial = checkRecordReasons({ results: [{ name: 'a', ok: true }] }, all);
    assert(/recorded 1 of 2/.test(partial[0] || ''), `a truncated record was not caught: ${JSON.stringify(partial)}`);
    const none = checkRecordReasons({ results: [] }, all);
    assert(/recorded 0 of 2/.test(none[0] || ''), `an empty record was not caught: ${JSON.stringify(none)}`);
    const red = checkRecordReasons({ results: [{ name: 'a', ok: true }, { name: 'b', ok: false }] }, all);
    assert(/RED: b/.test(red[0] || ''), `a red check was not named: ${JSON.stringify(red)}`);
    return 'partial and red are both named';
  });

  // ---------------------------------------------------------------- clean
  await checkAsync("clean removes only the stack's own leftovers", async () => {
    const d = configuredRepo();
    fs.mkdirSync(path.join(d, '.stack', 'state'), { recursive: true });
    const temp = path.join(d, '.stack', 'state', 'x.tmp');
    fs.writeFileSync(temp, 'half a write');
    fs.writeFileSync(path.join(d, 'foo.log'), 'run output\n');
    fs.writeFileSync(path.join(d, '.stack', 'plugin.log'), 'ready\n');

    const out = await runIn(d, 'clean', { op: 'sweep' });
    assert(!fs.existsSync(temp), 'the stack temp survived the sweep');
    assert(!fs.existsSync(path.join(d, '.stack', 'plugin.log')), "the plugin's own log survived the sweep");
    assert(out.includes('x.tmp') && out.includes('plugin.log'), `the removals were not named:\n${out}`);
    assert(fs.existsSync(path.join(d, 'foo.log')), 'a repo-root log was deleted');

    const report = await runIn(d, 'clean', { op: 'report' });
    assert(report.includes('foo.log'), `junk in the repo root was not named in the report:\n${report}`);
    assert(/What to do/.test(report) && /\.log`/.test(report), `the report gives no suggestion:\n${report}`);
    assert(fs.existsSync(path.join(d, 'foo.log')), 'the report deleted the junk it named');
    assert(!fs.existsSync(temp), 'the report deleted a stack temp');
    fs.rmSync(d, { recursive: true, force: true });
    return 'own temp and log removed, junk named and kept';
  });

  await checkAsync('clean removes a stale lock and keeps a live one', async () => {
    const d = configuredRepo();
    const lock = path.join(d, '.stack', 'state', '.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');

    const fresh = await runIn(d, 'clean', { op: 'sweep' });
    assert(fs.existsSync(lock), 'a fresh lock was removed');
    assert(/Kept/.test(fresh) && /lock in use/.test(fresh), `a fresh lock was not kept with a reason:\n${fresh}`);

    const stale = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(lock, stale, stale);
    const out = await runIn(d, 'clean', { op: 'sweep' });
    assert(!fs.existsSync(lock), 'a lock older than ten minutes survived');
    assert(/lock unused for/.test(out), `the stale lock was not named as stale:\n${out}`);
    fs.rmSync(d, { recursive: true, force: true });
    return 'fresh kept, stale removed';
  });

  await checkAsync('clean works without git and touches only .stack', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-clean-'));
    fs.mkdirSync(path.join(d, '.stack', 'briefs'), { recursive: true });
    fs.writeFileSync(path.join(d, '.stack', 'briefs', 'keep.md'), '# keep\n');
    fs.writeFileSync(path.join(d, '.stack', 'briefs', 'j.tmp'), 'crash\n');
    fs.writeFileSync(path.join(d, 'note.tmp'), 'not mine\n');

    const out = await runIn(d, 'clean', { op: 'sweep' });
    assert(!fs.existsSync(path.join(d, '.stack', 'briefs', 'j.tmp')), 'the stack temp survived');
    assert(fs.existsSync(path.join(d, '.stack', 'briefs', 'keep.md')), 'a real stack file was deleted');
    assert(fs.existsSync(path.join(d, 'note.tmp')), 'a file outside .stack was deleted');
    assert(!fs.existsSync(path.join(d, '.git')), 'clean created a repository');
    assert(/Found but not mine: 1/.test(out), `the outside temp was not reported as not ours:\n${out}`);
    fs.rmSync(d, { recursive: true, force: true });
    return 'no git needed, nothing outside .stack touched';
  });

  await checkAsync('clean on a pristine project says so plainly', async () => {
    const d = configuredRepo();
    const out = await runIn(d, 'clean', { op: 'sweep' });
    assert(/Nothing to remove/.test(out), `a clean stack did not say so:\n${out}`);
    assert(!/\| Removed \|/.test(out), `an empty table was rendered:\n${out}`);
    assert(fs.existsSync(path.join(d, '.stack', 'config.json')), 'the config was removed');
    fs.rmSync(d, { recursive: true, force: true });
    return 'nothing to remove';
  });

  await checkAsync('a brief copied over its report is not a report', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', {
      op: 'new', agent: 'backend',
      title: 'copied report',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['n.md'],
    });
    fs.copyFileSync(
      path.join(d, '.stack', 'briefs', 'copied-report.md'),
      path.join(d, '.stack', 'reports', 'copied-report.md'),
    );
    const out = await runIn(d, 'ready', { id: 'copied-report' });
    assert(/NO-GO/.test(out), `a brief copied over its report was accepted:\n${out}`);
    assert(/Outcome|no .*section/i.test(out), `the missing section was not named:\n${out}`);
    fs.rmSync(d, { recursive: true, force: true });
    return 'fenced headings are examples, not sections';
  });

  await checkAsync("a report in the brief's own example style is a report", async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', {
      op: 'new', agent: 'backend',
      title: 'template style',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['n.md'],
    });
    // The headings and their inline descriptions are copied from the template the
    // brief itself prints; the bodies underneath are real.
    fs.writeFileSync(
      path.join(d, '.stack', 'reports', 'template-style.md'),
      [
        '# template style',
        '',
        '## Outcome     what shipped, two or three sentences',
        'Retries stop at three.',
        '',
        '## Evidence    the command and the real output at the head you hand back',
        '`node -e "process.exit(0)"` exit 0.',
        '',
        '## Unverified  every claim you did not check, and why; "none" is a claim',
        'none',
        '',
        '## Scope       paths touched, each inside Owns, or why not',
        '`.stack/reports/template-style.md` only.',
        '',
        '## Lesson      one paragraph the next employee should know',
        'A template the gate rejects is a template that teaches a lie.',
        '',
      ].join('\n'),
    );
    const out = await runIn(d, 'ready', { id: 'template-style' });
    assert(/## GO\b/.test(out), `a report in the brief's own template was refused:\n${out}`);
    fs.rmSync(d, { recursive: true, force: true });
    return "the brief's example headings pass the gate";
  });

  await checkAsync('a fenced example is never a report section', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', {
      op: 'new', agent: 'backend',
      title: 'fenced example',
      out: 'a thing',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['n.md'],
    });
    const reportFile = path.join(d, '.stack', 'reports', 'fenced-example.md');
    const report = (outcome) =>
      [
        '# fenced example',
        '',
        ...outcome,
        '',
        '## Evidence',
        '`node -e "process.exit(0)"` exit 0.',
        '',
        '## Unverified',
        'none',
        '',
        '## Scope',
        '`.stack/**` only.',
        '',
        '## Lesson',
        'An example is not evidence.',
        '',
      ].join('\n');

    // Five real sections, plus a fenced block that repeats a heading: the fence is
    // an example and must be skipped, so this lands.
    fs.writeFileSync(
      reportFile,
      report([
        '## Outcome',
        'Retries stop at three.',
        '',
        '```text',
        '## Outcome     what shipped, two or three sentences',
        'An example body inside a fence.',
        '```',
      ]),
    );
    const go = await runIn(d, 'ready', { id: 'fenced-example' });
    assert(/## GO\b/.test(go), `a report with a fenced example after its real sections was refused:\n${go}`);

    // The discriminating case: the only Outcome body is fenced. A fence-blind
    // parser counts the example as a body and gates GO on it.
    fs.writeFileSync(
      reportFile,
      report([
        '## Outcome',
        '```text',
        '## Outcome     what shipped, two or three sentences',
        'An example body inside a fence.',
        '```',
      ]),
    );
    const no = await runIn(d, 'ready', { id: 'fenced-example' });
    assert(/NO-GO/.test(no), `a fenced example body was accepted as evidence:\n${no}`);
    assert(/outcome/i.test(no), `the empty outcome section was not named:\n${no}`);

    fs.rmSync(d, { recursive: true, force: true });
    return 'a fenced body is not a body';
  });

  await checkAsync('a brief with no recorded base is refused, not passed', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'no head', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    const gate = await runIn(d, 'ready', { id: 'no-head', lean: true });
    assert(/## GO/.test(gate), `setup gate failed:\n${gate}`);

    const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    delete index[0].head;
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    const missing = await runIn(d, 'ready', { id: 'no-head', lean: true });
    assert(/NO-GO/.test(missing), 'a brief with no base was gated GO');
    assert(/no base commit/i.test(missing), `the missing base was not named:\n${missing}`);

    index[0].head = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    const unreadable = await runIn(d, 'ready', { id: 'no-head', lean: true });
    assert(/NO-GO/.test(unreadable), 'a range git cannot read was gated GO');
    assert(/could not read the committed range/i.test(unreadable), `the unreadable range was not named:\n${unreadable}`);

    fs.rmSync(d, { recursive: true, force: true });
    return 'no base and bad base both refuse';
  });

  await checkAsync('re-briefing a landed seam needs force and says why', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'shipped seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    await runIn(d, 'check', { op: 'run' });
    const gate = await runIn(d, 'ready', { id: 'shipped-seam', lean: true });
    assert(/## GO/.test(gate), gate);
    await runIn(d, 'brief', { op: 'status', id: 'shipped-seam', status: 'landed' });

    const refused = await runIn(d, 'brief', { op: 'new', agent: 'backend', title: 'shipped seam again', id: 'shipped-seam', out: 'y', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    assert(/Refused/.test(refused), 'a landed seam was silently re-briefed');
    assert(/landed/.test(refused) && /force/.test(refused), `the refusal names neither the state nor the override:\n${refused}`);
    const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
    assert(JSON.parse(fs.readFileSync(indexFile, 'utf8'))[0].status === 'landed', 'the state was reset anyway');

    const forced = await runIn(d, 'brief', {
      op: 'new', agent: 'backend',
      title: 'shipped seam again',
      id: 'shipped-seam',
      out: 'y',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['n.md'],
      force: true,
    });
    assert(/Brief written/.test(forced), `force did not overwrite: ${forced.slice(0, 120)}`);
    assert(JSON.parse(fs.readFileSync(indexFile, 'utf8'))[0].status === 'briefed', 'force did not re-open the seam');
    fs.rmSync(d, { recursive: true, force: true });
    return 'refused, then forced';
  });

  fs.rmSync(dir, { recursive: true, force: true });
}
