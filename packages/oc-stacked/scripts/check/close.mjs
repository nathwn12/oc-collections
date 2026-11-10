/**
 * The close gate, made falsifiable: the preflight blocker matrix, GO and NO-GO,
 * the receipt that names its own HEAD, and the cheap preflight the idle loop can
 * afford.
 *
 * Every case starts from a repo that was just GO and changes exactly one fact, so
 * a gate that stopped reading that fact fails here instead of in a live session.
 * The verdict is asserted as a word at the head of a line, never as a layout.
 *
 * Split out of scripts/check.mjs; the runner is scripts/check/index.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CLOSE_PATH, closeReasons, invalidateClose, preflight } from '../../lib/close.js';
import { head } from '../../lib/git.js';

export async function register(ctx) {
  const { checkAsync, assert, tmpRepo, commitAll, configuredRepo, runIn } = ctx;

  const closeFile = (d) => path.join(d, ...CLOSE_PATH.split('/'));
  const shut = (d) => fs.rmSync(d, { recursive: true, force: true });

  /** A receipt that is a GO the moment it is written, for the cases that need one. */
  const receiptFor = (d) => {
    const sha = head(d);
    return {
      go: true,
      receipt_id: 'fixture-receipt',
      sealed: sha ? sha.slice(0, 7) : 'no-head',
      at: new Date().toISOString(),
      head: sha,
      branch: 'main',
      tree: [],
      criteria: [{ id: 'preflight', status: 'pass', evidence: [] }],
      checks: { at: new Date().toISOString(), head: sha, results: [{ name: 'ok', ok: true, code: 0, ms: 1 }] },
      sweep: { removed: [], kept: [] },
      junk: [],
      atlas: { status: 'not configured', code: null, ms: 0 },
      lesson: 'a fixture receipt, written by the check itself',
    };
  };
  const writeReceipt = (d) => {
    fs.mkdirSync(path.join(d, '.stack', 'state'), { recursive: true });
    fs.writeFileSync(closeFile(d), JSON.stringify(receiptFor(d), null, 2));
  };
  const writeIndex = (d, briefs) => {
    fs.mkdirSync(path.join(d, '.stack', 'state'), { recursive: true });
    fs.writeFileSync(path.join(d, '.stack', 'state', 'briefs.json'), JSON.stringify(briefs, null, 2));
  };

  /** A committed repo with an arbitrary config: no checks, an atlas, or both. */
  const repoWith = (cfg) => {
    const d = tmpRepo();
    fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
    fs.writeFileSync(path.join(d, '.stack', 'config.json'), JSON.stringify(cfg, null, 2));
    commitAll(d, 'seed config');
    return d;
  };

  const preflightOf = (d) => runIn(d, 'close', { op: 'preflight' });
  const seal = (d, lesson) => runIn(d, 'close', lesson ? { op: 'run', lesson } : { op: 'run' });
  /** The blocker reasons, read from the contract rather than from the rendered table. */
  const blockersOf = async (d) => (await preflight(d, { lesson: '', atlas: false })).blockers.join('\n');

  const GO = /^## GO\b/m;
  const BLOCKED = /^## BLOCKED\b/m;
  const NO_GO = /^## NO-GO\b/m;

  // ---------------------------------------------------------------- the happy path
  await checkAsync('a clean repo with a passing check has no close blocker', async () => {
    const d = configuredRepo();
    const text = await preflightOf(d);
    assert(GO.test(text), `preflight was not GO:\n${text}`);
    assert(!BLOCKED.test(text), `a blocker was named on a clean repo:\n${text}`);
    assert(/No open ticket/.test(text), `an empty ticket list was not stated plainly:\n${text}`);
    shut(d);
    return 'GO, no ticket';
  });

  await checkAsync('a GO close writes a receipt at HEAD and ends with the SEALED token', async () => {
    const d = configuredRepo();
    const sha = head(d);
    const text = await seal(d, 'the close is one gate, not a checklist');

    assert(GO.test(text), `not a GO:\n${text}`);
    assert(text.trim().endsWith(`SEALED ${sha.slice(0, 7)}`), `the text does not end with the token:\n${text}`);

    assert(fs.existsSync(closeFile(d)), `${CLOSE_PATH} was not written`);
    const written = JSON.parse(fs.readFileSync(closeFile(d), 'utf8'));
    assert(written.go === true, 'the receipt is not a GO');
    assert(written.head === sha, `the receipt is bound to ${written.head}, HEAD is ${sha}`);
    assert(written.sealed === sha.slice(0, 7), `sealed is ${written.sealed}, not the first 7 of HEAD`);

    const reasons = closeReasons(d);
    assert(!reasons.length, `a fresh GO still has reasons: ${reasons.join('; ')}`);
    shut(d);
    return `SEALED ${written.sealed}`;
  });

  // ---------------------------------------------------------------- NO-GO
  await checkAsync('a red check refuses the seal and deletes the earlier receipt', async () => {
    const d = configuredRepo('node -e "process.exit(3)"');
    writeReceipt(d);
    assert(!closeReasons(d).length, 'the fixture receipt was not a GO before the run');

    const text = await seal(d, 'a red check must not seal');
    assert(NO_GO.test(text), `a red check was sealed:\n${text}`);
    assert(/check is RED/.test(text), `the red check was not the named reason:\n${text}`);
    assert(!fs.existsSync(closeFile(d)), 'the earlier GO survived a failed close');

    const reasons = closeReasons(d);
    assert(reasons.length, 'a deleted receipt still reads as a GO');
    assert(/no close receipt/.test(reasons[0]), `the missing receipt was not named: ${reasons[0]}`);
    shut(d);
    return 'RED, receipt deleted';
  });

  await checkAsync('a close with no lesson is refused before any work and leaves the receipt alone', async () => {
    const d = configuredRepo();
    writeReceipt(d);
    const before = fs.readFileSync(closeFile(d), 'utf8');

    const text = await seal(d);
    assert(NO_GO.test(text), `a close with no lesson sealed:\n${text}`);
    assert(/needs `lesson`/.test(text), `the missing lesson was not named:\n${text}`);
    assert(/left alone/.test(text), `the refusal does not say what it did to the old receipt:\n${text}`);
    assert(fs.readFileSync(closeFile(d), 'utf8') === before, 'a refusal before work touched the receipt');
    shut(d);
    return 'refused before work';
  });

  // ---------------------------------------------------------------- why a receipt stops being a GO
  await checkAsync('a receipt stops being a GO after a commit, after invalidateClose, and when corrupt', async () => {
    const d = configuredRepo();
    writeReceipt(d);
    assert(!closeReasons(d).length, 'the fixture receipt was not a GO');

    fs.writeFileSync(path.join(d, 'work.ts'), 'export const moved = 1;\n');
    commitAll(d, 'move head');
    const moved = closeReasons(d);
    assert(moved.length, 'a receipt for an older HEAD still read as a GO');
    assert(/receipt is for .* but HEAD is/.test(moved[0]), `the moved head was not named: ${moved[0]}`);

    writeReceipt(d);
    const invalidated = invalidateClose(d, 'a new turn started');
    assert(invalidated && invalidated.invalidated === 'a new turn started', 'invalidateClose did not mark the receipt');
    const stale = closeReasons(d);
    assert(stale.length, 'an invalidated receipt still read as a GO');
    assert(/invalidated: a new turn started/.test(stale[0]), `the reason was not kept: ${stale[0]}`);

    fs.writeFileSync(closeFile(d), '{ not json');
    const corrupt = closeReasons(d);
    assert(corrupt.length, 'a corrupt receipt was read as absent-and-GO');
    assert(/unreadable/.test(corrupt[0]), `a corrupt receipt was not named as corrupt: ${corrupt[0]}`);
    shut(d);
    return 'moved, invalidated, corrupt';
  });

  // ---------------------------------------------------------------- the blocker matrix
  await checkAsync('uncommitted work outside .stack blocks the close and is named', async () => {
    const d = configuredRepo();
    assert(GO.test(await preflightOf(d)), 'the fixture was not GO before the change');

    fs.writeFileSync(path.join(d, 'loose.ts'), 'export const loose = 1;\n');
    const text = await preflightOf(d);
    assert(BLOCKED.test(text), `a dirty path was not a blocker:\n${text}`);
    assert(/loose\.ts/.test(text), `the dirty path was not named for the owner:\n${text}`);
    assert(/uncommitted work outside the stack: `loose\.ts`/.test(await blockersOf(d)), 'the dirty path is not a named blocker');
    shut(d);
    return 'loose.ts named';
  });

  await checkAsync('a live seam blocks the close, and killing it clears the block', async () => {
    const d = configuredRepo();
    writeIndex(d, [{ id: 'retry-budget', status: 'briefed' }]);
    const blocked = await preflightOf(d);
    assert(BLOCKED.test(blocked), `a live seam was not a blocker:\n${blocked}`);
    assert(/retry-budget/.test(blocked), `the live seam was not named for the owner:\n${blocked}`);
    assert(/seam retry-budget is briefed, not landed or killed/.test(await blockersOf(d)), 'a live seam is not a named blocker');

    writeIndex(d, [{ id: 'retry-budget', status: 'killed' }]);
    const clear = await preflightOf(d);
    assert(GO.test(clear), `a killed seam still blocked:\n${clear}`);
    shut(d);
    return 'briefed blocks, killed clears';
  });

  await checkAsync('a landed seam needs an AUDIT naming its exact id, not a prefix of it', async () => {
    const d = configuredRepo();
    writeIndex(d, [{ id: 'close-gate-tests', status: 'landed' }]);
    const unaudited = await preflightOf(d);
    assert(BLOCKED.test(unaudited), `a landed seam with no AUDIT was not a blocker:\n${unaudited}`);
    assert(/AUDIT/.test(unaudited), `the missing AUDIT was not named for the owner:\n${unaudited}`);
    assert(/close-gate-tests landed with no AUDIT line naming it/.test(await blockersOf(d)), 'an unaudited landing is not a named blocker');

    // `close` is a prefix of `close-gate-tests`; a substring match would accept it.
    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: 'close: pass, the gate holds' });
    const prefixed = await preflightOf(d);
    assert(BLOCKED.test(prefixed), `an AUDIT for a prefix satisfied a longer seam id:\n${prefixed}`);

    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: 'close-gate-tests: pass, the gate holds' });
    const clear = await preflightOf(d);
    assert(GO.test(clear), `an AUDIT naming the seam did not clear it:\n${clear}`);
    shut(d);
    return 'prefix refused, exact id accepted';
  });

  await checkAsync('an unanswered ASK blocks the close, and an ANSWER clears it', async () => {
    const d = configuredRepo();
    await runIn(d, 'ledger', { op: 'log', kind: 'ASK', text: 'ship before the release?' });
    const blocked = await preflightOf(d);
    assert(BLOCKED.test(blocked), `an open ASK was not a blocker:\n${blocked}`);
    assert(/open ticket: ASK/.test(blocked) && /ship before the release/.test(blocked), `the ask was not named:\n${blocked}`);

    await runIn(d, 'ledger', { op: 'log', kind: 'ANSWER', text: 'yes, the owner said ship' });
    const clear = await preflightOf(d);
    assert(GO.test(clear), `an answered ASK still blocked:\n${clear}`);
    shut(d);
    return 'ASK blocks, ANSWER clears';
  });

  await checkAsync('a repo with no configured check cannot close', async () => {
    const d = repoWith({ checks: [] });
    const text = await preflightOf(d);
    assert(BLOCKED.test(text), `a repo with nothing to prove was GO:\n${text}`);
    assert(/no proving check is configured/.test(text), `the missing check was not named:\n${text}`);
    shut(d);
    return 'nothing to prove is not green';
  });

  // ---------------------------------------------------------------- cheap preflight
  await checkAsync('op=preflight reads files only: a failing atlas command is never executed', async () => {
    const d = repoWith({
      checks: [{ name: 'ok', command: 'node -e "process.exit(0)"', timeout: 30000 }],
      atlas: { command: 'node -e "process.exit(9)"' },
    });

    const cheap = await preflightOf(d);
    assert(GO.test(cheap), `the cheap preflight was not GO:\n${cheap}`);
    assert(!/atlas command failed/.test(cheap), `the cheap preflight ran the atlas:\n${cheap}`);
    assert(/atlas .* not run in a preflight/.test(cheap), `the skipped atlas was not said out loud:\n${cheap}`);

    // The discriminating half: the same config, with the atlas allowed, is red.
    // A preflight that ignores `atlas: false` fails the assertions above; one that
    // never runs the atlas at all fails this one.
    const full = await preflight(d, { lesson: 'nine characters', atlas: true });
    assert(full.blockers.length, 'the failing atlas command was not a blocker when it ran');
    assert(/atlas command failed/.test(full.blockers.join('\n')), `the atlas failure was not named: ${full.blockers.join('; ')}`);
    assert(/exit 9/.test(full.blockers.join('\n')), `the atlas exit code was not named: ${full.blockers.join('; ')}`);
    shut(d);
    return 'cheap is GO, ceremony pays for the atlas';
  });

  // ---------------------------------------------------------------- show
  await checkAsync('op=show prints the receipt and whether it is still valid at HEAD', async () => {
    const d = configuredRepo();
    const empty = await runIn(d, 'close', { op: 'show' });
    assert(/no close receipt/.test(empty), `an absent receipt was not named:\n${empty}`);

    writeReceipt(d);
    const sha = head(d);
    const shown = await runIn(d, 'close', { op: 'show' });
    assert(GO.test(shown) && /fixture-receipt/.test(shown), `a valid receipt did not read as itself:\n${shown}`);
    assert(shown.includes(`SEALED ${sha.slice(0, 7)}`), `the shown receipt carries no token:\n${shown}`);

    fs.writeFileSync(path.join(d, 'work.ts'), 'export const moved = 1;\n');
    commitAll(d, 'move head');
    const moved = await runIn(d, 'close', { op: 'show' });
    assert(NO_GO.test(moved), `a stale receipt read GO:\n${moved}`);
    assert(/Not valid at HEAD/.test(moved) && /receipt is for/.test(moved), `the invalidity was not named:\n${moved}`);
    shut(d);
    return 'GO, then NO-GO at a new head';
  });
}
