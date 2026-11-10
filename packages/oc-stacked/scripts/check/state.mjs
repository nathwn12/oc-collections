/**
 * Atomic writes, the lock, the ledger, the digest, and seeding.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { detectChecks, seedStack } from '../../lib/state.js';
import { toolDefinitions } from '../../lib/tools.js';

export async function register(ctx) {
  const { check, checkAsync, assert, repo, tmpRepo, configuredRepo, runIn } = ctx;

  // A committed check and one live brief: the two rows the digest renders.
  await checkAsync('ledger appends and the digest is derived from it', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', {
      op: 'new', agent: 'employee',
      title: 'retry budget',
      out: 'a failing endpoint is retried at most three times',
      check: 'node -e "process.exit(0)"',
      owns: ['**'],
      files: ['n.md'],
    });
    await runIn(d, 'ledger', { op: 'log', kind: 'ASK', text: 'D1 · ship before the release? recommend yes because the check is green' });
    await runIn(d, 'ledger', { op: 'log', kind: 'NOTE', text: 'intake: make webhooks retry honestly' });
    const digest = await runIn(d, 'ledger', { op: 'digest' });
    assert(digest.includes('## Needs you'), 'digest has no Needs-you section');
    assert(digest.includes('D1 ·'), 'digest dropped the open ask');
    assert(digest.includes('## In progress'), 'digest has no In-progress section');
    assert(digest.includes('retry-budget'), 'digest does not list the live brief');
    assert(fs.existsSync(path.join(d, '.stack', 'digest.md')), 'digest.md was not written');
    const tail = await runIn(d, 'ledger', { op: 'tail', limit: 5 });
    assert(tail.includes('ASK'), 'tail dropped an entry');
    fs.rmSync(d, { recursive: true, force: true });
    return 'Needs you / New / In progress';
  });

  // ---------------------------------------------------------------- check detection
  const detector = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-detect-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
    return d;
  };

  await checkAsync('an empty virtual cargo workspace declares no check', async () => {
    const d = detector({ 'Cargo.toml': '[workspace]\nmembers = []\n' });
    const checks = detectChecks(d);
    assert(!checks.some((c) => c.name === 'cargo'), `an empty virtual workspace invented a cargo check: ${JSON.stringify(checks)}`);
    assert(!checks.some((c) => c.command === 'cargo test'), `an empty virtual workspace invented cargo test: ${JSON.stringify(checks)}`);
    fs.rmSync(d, { recursive: true, force: true });
    return 'members = [] adds nothing';
  });

  await checkAsync('a cargo package declares one test check', async () => {
    const d = detector({ 'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n' });
    const checks = detectChecks(d);
    assert(checks.some((c) => c.name === 'cargo' && c.command === 'cargo test'), `a [package] manifest produced no cargo test: ${JSON.stringify(checks)}`);
    fs.rmSync(d, { recursive: true, force: true });
    return 'cargo test';
  });

  await checkAsync('a cargo workspace with members declares one test check', async () => {
    const d = detector({ 'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\n' });
    const checks = detectChecks(d);
    assert(checks.some((c) => c.name === 'cargo' && c.command === 'cargo test'), `a workspace with members produced no cargo test: ${JSON.stringify(checks)}`);
    fs.rmSync(d, { recursive: true, force: true });
    return 'cargo test';
  });

  // ---------------------------------------------------------------- seeding, objective, audit
  await checkAsync('a project is seeded and re-seeded without losing a hand-written check', async () => {
    const d = tmpRepo();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
    const first = seedStack(d);
    assert(first.ok, 'seed refused a git repo');
    assert(fs.existsSync(path.join(d, '.stack', 'config.json')), 'config missing');
    assert(fs.existsSync(path.join(d, '.stack', 'ledger.md')), 'ledger missing');
    assert(fs.existsSync(path.join(d, '.stack', 'digest.md')), 'digest missing');
    const cfg = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'config.json'), 'utf8'));
    assert(cfg.checks.some((c) => c.name === 'test'), 'the test script was not detected');

    cfg.checks.push({ name: 'mine', command: 'node -e "process.exit(0)"', timeout: 1000 });
    fs.writeFileSync(path.join(d, '.stack', 'config.json'), JSON.stringify(cfg, null, 2));
    seedStack(d);
    const again = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'config.json'), 'utf8'));
    assert(again.checks.filter((c) => c.name === 'mine').length === 1, 'a hand-written check was lost or duplicated');
    assert(again.checks.filter((c) => c.name === 'test').length === 1, 'a detected check was duplicated');

    fs.rmSync(d, { recursive: true, force: true });
    return 'detected, preserved, idempotent';
  });

  await checkAsync('a trimmed check list is not re-imposed by a second seed', async () => {
    const d = tmpRepo();
    fs.writeFileSync(
      path.join(d, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' } }),
    );
    seedStack(d);
    const cfgFile = path.join(d, '.stack', 'config.json');
    const seeded = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert(seeded.checks.some((c) => c.name === 'build'), `the fixture never detected build, so the trim proves nothing: ${JSON.stringify(seeded.checks)}`);
    fs.writeFileSync(cfgFile, JSON.stringify({ ...seeded, checks: [{ name: 'test', command: 'node -e "process.exit(0)"', timeout: 240000 }] }, null, 2));
    seedStack(d);
    seedStack(d);
    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    assert(
      after.checks.length === 1 && after.checks[0].name === 'test',
      `the trim was re-imposed: ${JSON.stringify(after.checks)}`,
    );
    fs.rmSync(d, { recursive: true, force: true });
    return 'one check stays one across two seeds';
  });

  await checkAsync('a missing or corrupt config still installs the detected checks', async () => {
    for (const label of ['missing', 'corrupt']) {
      const d = tmpRepo();
      fs.writeFileSync(
        path.join(d, 'package.json'),
        JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"' } }),
      );
      if (label === 'corrupt') {
        fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
        fs.writeFileSync(path.join(d, '.stack', 'config.json'), '{ not json');
      }
      const result = seedStack(d);
      assert(result.ok, `seed refused a repo with a ${label} config`);
      const cfg = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'config.json'), 'utf8'));
      assert(
        cfg.checks.map((c) => c.name).sort().join(',') === 'build,test',
        `a ${label} config did not install the detected checks: ${JSON.stringify(cfg.checks)}`,
      );
      fs.rmSync(d, { recursive: true, force: true });
    }
    return 'missing and corrupt both install detected checks';
  });

  await checkAsync('a directory that is not a project is left alone', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-plain-'));
    const result = seedStack(d);
    assert(!result.ok, 'seeded a directory with no repository and no manifest');
    assert(!fs.existsSync(path.join(d, '.stack')), 'it wrote .stack anyway');
    fs.rmSync(d, { recursive: true, force: true });
    return 'no .git, no manifest, no writes';
  });

  await checkAsync('the digest renders the objective and flags a landed seam with no verdict', async () => {
    const d = tmpRepo();
    fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
    fs.writeFileSync(
      path.join(d, '.stack', 'config.json'),
      JSON.stringify({ checks: [{ name: 'ok', command: 'node -e "process.exit(0)"', timeout: 30000 }] }, null, 2),
    );
    spawnSync('git', ['add', '-A'], { cwd: d, windowsHide: true });
    spawnSync('git', ['-c', 'user.email=c@l', '-c', 'user.name=c', 'commit', '-qm', 'base'], { cwd: d, windowsHide: true });
    await runIn(d, 'ledger', { op: 'log', kind: 'INTAKE', text: 'make webhooks retry honestly' });
    await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'audited seam', out: 'a thing', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    await runIn(d, 'check', { op: 'run' });
    await runIn(d, 'ready', { id: 'audited-seam', lean: true });
    await runIn(d, 'brief', { op: 'status', id: 'audited-seam', status: 'landed' });

    const digest = await runIn(d, 'ledger', { op: 'digest' });
    assert(/\*\*Objective\*\* — make webhooks retry honestly/.test(digest), 'the objective is not in the digest');
    assert(/Landed, unaudited/.test(digest), 'a landed seam with no verdict was not flagged');

    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: 'audited-seam@abc1234 PASS spec=ok standards=ok' });
    const after = await runIn(d, 'ledger', { op: 'digest' });
    assert(!/Landed, unaudited/.test(after), 'the audit line did not clear the flag');

    fs.rmSync(d, { recursive: true, force: true });
    return 'objective rendered, audit clears the flag';
  });

  await checkAsync('a CRLF ledger still yields its verdicts', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'crlf seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    const ledger = path.join(d, '.stack', 'ledger.md');
    fs.writeFileSync(ledger, fs.readFileSync(ledger, 'utf8').replace(/\r?\n/g, '\r\n'));
    await runIn(d, 'ledger', { op: 'log', kind: 'READY', text: 'crlf-seam: GO' });
    const out = await runIn(d, 'brief', { op: 'status', id: 'crlf-seam', status: 'landed' });
    assert(!/Refused/.test(out), `a CRLF ledger lost its verdict:\n${out}`);
    const index = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'state', 'briefs.json'), 'utf8'));
    assert(index[0].status === 'landed', 'the status did not change');
    fs.rmSync(d, { recursive: true, force: true });
    return 'CRLF parsed, landed';
  });

  await checkAsync('a corrupt brief index is named, not silently emptied', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'keep me', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
    fs.writeFileSync(indexFile, '{ not json');
    const list = await runIn(d, 'brief', { op: 'list' });
    assert(/unreadable|not valid JSON/i.test(list), `the corrupt index read as an empty list:\n${list}`);
    const created = await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'new seam', out: 'y', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    assert(/Refused/.test(created), 'a new brief overwrote a corrupt index');
    assert(fs.readFileSync(indexFile, 'utf8') === '{ not json', 'the corrupt index was destroyed');
    fs.rmSync(d, { recursive: true, force: true });
    return 'named, refused, preserved';
  });

  await checkAsync('a blocked temp file leaves the brief index intact', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'atomic seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
    const before = fs.readFileSync(indexFile, 'utf8');
    fs.mkdirSync(`${indexFile}.tmp`);
    const out = await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'second seam', out: 'y', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    assert(/Refused/.test(out), `a failed index write was reported as success:\n${out}`);
    assert(fs.readFileSync(indexFile, 'utf8') === before, 'the index was truncated by the failed write');
    assert(!fs.existsSync(path.join(d, '.stack', 'briefs', 'second-seam.md')), 'the body from the failed write survived');
    fs.rmSync(`${indexFile}.tmp`, { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
    return 'index byte-identical, body rolled back';
  });

  await checkAsync('a held lock blocks a write instead of racing it', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'locked seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    const indexFile = path.join(d, '.stack', 'state', 'briefs.json');
    const before = fs.readFileSync(indexFile, 'utf8');
    const lock = path.join(d, '.stack', 'state', '.lock');
    fs.writeFileSync(lock, 'held');
    const blocked = await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'blocked seam', out: 'y', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['b.md'] });
    assert(/Refused/.test(blocked) && /acquire/.test(blocked), `a held lock was ignored:\n${blocked}`);
    assert(fs.readFileSync(indexFile, 'utf8') === before, 'the index changed while the lock was held');
    fs.unlinkSync(lock);
    const after = await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'after seam', out: 'z', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['c.md'] });
    assert(/Brief written/.test(after), 'the lock was not released by the failed writer');
    fs.rmSync(d, { recursive: true, force: true });
    return 'waited, refused, then wrote';
  });

  await checkAsync('logging onto a file with no final newline does not merge entries', async () => {
    const d = tmpRepo();
    fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
    const ledger = path.join(d, '.stack', 'ledger.md');
    fs.writeFileSync(ledger, '# Stack ledger\n\n- 2020-01-01T00:00:00.000Z · NOTE · first');
    await runIn(d, 'ledger', { op: 'log', kind: 'NOTE', text: 'second' });
    const lines = fs.readFileSync(ledger, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('- '));
    assert(lines.length === 2, `entries merged: ${JSON.stringify(lines)}`);
    assert(/· first$/.test(lines[0]), `the first entry was altered: ${lines[0]}`);
    assert(/· second$/.test(lines[1]), `the second entry is wrong: ${lines[1]}`);
    fs.rmSync(d, { recursive: true, force: true });
    return 'newline repaired before append';
  });

  await checkAsync('seeding writes the stack gitignore and keeps a hand-written one', async () => {
    const d = tmpRepo();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
    assert(seedStack(d).ok, 'seed refused a repo');
    const ignoreFile = path.join(d, '.stack', '.gitignore');
    assert(fs.existsSync(ignoreFile), '.stack/.gitignore was not written');
    const text = fs.readFileSync(ignoreFile, 'utf8');
    assert(/state\//.test(text) && /plugin\.log/.test(text), `the ignore file omits state/ or plugin.log: ${JSON.stringify(text)}`);
    fs.writeFileSync(ignoreFile, 'custom\n');
    seedStack(d);
    assert(fs.readFileSync(ignoreFile, 'utf8') === 'custom\n', 'seeding overwrote a hand-written .gitignore');
    fs.rmSync(d, { recursive: true, force: true });
    return 'state/ and plugin.log ignored';
  });

  await checkAsync('seeding prunes an old temp and a stale lock, and keeps a live write', async () => {
    const d = tmpRepo();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x' }));
    seedStack(d);
    const state = path.join(d, '.stack', 'state');
    fs.mkdirSync(state, { recursive: true });
    const oldTmp = path.join(state, 'old.tmp');
    const newTmp = path.join(state, 'new.tmp');
    const lock = path.join(state, '.lock');
    fs.writeFileSync(oldTmp, 'half a write\n');
    fs.writeFileSync(newTmp, 'half a write\n');
    fs.writeFileSync(lock, '');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);
    fs.utimesSync(lock, twoHoursAgo, twoHoursAgo);

    const result = seedStack(d);
    assert(!fs.existsSync(oldTmp), 'a temp older than an hour survived the seed');
    assert(!fs.existsSync(lock), 'a stale lock survived the seed');
    assert(fs.existsSync(newTmp), 'a temp younger than an hour was pruned; it may belong to a write in flight');
    assert(result.removed.includes('.stack/state/old.tmp'), `the prune was not reported: ${JSON.stringify(result.removed)}`);
    fs.rmSync(d, { recursive: true, force: true });
    return 'old temp and stale lock pruned, live write kept';
  });

  await checkAsync('a corrupt config is signalled and rewritten by seeding', async () => {
    const d = tmpRepo();
    fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
    fs.writeFileSync(path.join(d, '.stack', 'config.json'), '{ not json');
    const result = seedStack(d);
    assert(result.ok, 'seed refused a repo');
    const cfg = JSON.parse(fs.readFileSync(path.join(d, '.stack', 'config.json'), 'utf8'));
    assert(Array.isArray(cfg.checks), 'the rewritten config has no checks list');
    assert(Array.isArray(cfg.ownership?.ignore) && cfg.ownership.ignore.includes('.stack/**'), 'the rewritten config lost the ignore list');
    assert(
      result.updated.includes('.stack/config.json') || result.created.includes('.stack/config.json'),
      'the rewrite was not reported',
    );
    fs.rmSync(d, { recursive: true, force: true });
    return 'corrupt config replaced';
  });

  await checkAsync('the digest finds the objective, open ask, and audit across the whole ledger', async () => {
    const d = configuredRepo();
    await runIn(d, 'brief', { op: 'new', agent: 'employee', title: 'deep seam', out: 'x', check: 'node -e "process.exit(0)"', owns: ['**'], files: ['n.md'] });
    await runIn(d, 'check', { op: 'run' });
    assert(/## GO/.test(await runIn(d, 'ready', { id: 'deep-seam', lean: true })), 'setup gate failed');
    await runIn(d, 'brief', { op: 'status', id: 'deep-seam', status: 'landed' });
    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: 'deep-seam@abc1234 PASS spec=ok standards=ok' });
    await runIn(d, 'ledger', { op: 'log', kind: 'INTAKE', text: 'make the deep ledger honest' });
    await runIn(d, 'ledger', { op: 'log', kind: 'ASK', text: 'D9 · ship it? recommend yes' });
    for (let i = 0; i < 220; i += 1) await runIn(d, 'ledger', { op: 'log', kind: 'NOTE', text: `noise ${i}` });
    const digest = await runIn(d, 'ledger', { op: 'digest' });
    assert(/make the deep ledger honest/.test(digest), 'the objective fell out of the display window');
    assert(/D9 ·/.test(digest), 'the open ask fell out of the display window');
    assert(!/Landed, unaudited/.test(digest), 'the audit fell out of the display window');
    fs.rmSync(d, { recursive: true, force: true });
    return 'objective, ask, audit survive 220 notes';
  });

  check('the ledger description names every kind the digest reads', () => {
    const description = toolDefinitions({ dir: repo }).find((t) => t.name === 'ledger').description;
    for (const kind of ['INTAKE', 'AUDIT', 'SWARM', 'SEED']) {
      assert(description.includes(kind), `the ledger description omits ${kind}`);
    }
    return 'INTAKE, AUDIT, SWARM, SEED';
  });
}
