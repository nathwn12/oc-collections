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
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLOSE_PATH, closeReasons, invalidateClose, preflight, signReceipt } from '../../lib/close.js';
import { head } from '../../lib/git.js';

export async function register(ctx) {
  const { checkAsync, assert, tmpRepo, commitAll, configuredRepo, runIn } = ctx;

  const closeFile = (d) => path.join(d, ...CLOSE_PATH.split('/'));
  const shut = (d) => fs.rmSync(d, { recursive: true, force: true });

  /**
   * A receipt the current close would accept: a real uuid, this repo's HEAD, a
   * check run bound to that HEAD, a passing preflight, and a signature from the
   * same key the writer uses. A fixture the code refuses on its own shape can
   * never prove anything about the behaviour under test.
   *
   * `head` overrides the bound head for the cases about a head the close must
   * refuse (a prefix, a short sha, a missing one); `sealed` and the check run
   * follow it, so the head is the only fact those cases get to be wrong about.
   */
  const receiptFor = (d, { head: override } = {}) => {
    const sha = override === undefined ? head(d) : override;
    const bound = typeof sha === 'string' ? sha : '';
    const at = new Date().toISOString();
    const body = {
      go: true,
      receipt_id: randomUUID(),
      sealed: bound.slice(0, 7),
      at,
      head: sha,
      branch: 'main',
      tree: [],
      criteria: [{ id: 'preflight', status: 'pass', evidence: [] }],
      checks: { at, head: bound, results: [{ name: 'ok', ok: true, code: 0, ms: 1 }] },
      sweep: { removed: [], kept: [] },
      junk: [],
      atlas: { status: 'not configured', code: null, ms: 0 },
      lesson: 'a fixture receipt, written by the check itself',
    };
    return { ...body, sig: signReceipt(body) };
  };
  const writeReceipt = (d, options) => {
    fs.mkdirSync(path.join(d, '.stack', 'state'), { recursive: true });
    fs.writeFileSync(closeFile(d), JSON.stringify(receiptFor(d, options), null, 2));
  };
  /**
   * A refusal replaces the receipt with a tombstone instead of deleting it, so
   * the contract is "no GO survives", which is what this asserts. A refusal that
   * left a readable GO behind would still pass a check that only looked for the
   * file's absence.
   */
  const refusalOnDisk = (d) => {
    assert(fs.existsSync(closeFile(d)), `the refusal left no record at ${CLOSE_PATH}`);
    const record = JSON.parse(fs.readFileSync(closeFile(d), 'utf8'));
    assert(record && record.go === false, `the refusal left a GO on disk (go: ${JSON.stringify(record && record.go)})`);
    return record;
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
    assert(Array.isArray(written.tree) && !written.tree.length, `a GO receipt carries a dirty tree: ${JSON.stringify(written.tree)}`);

    const reasons = closeReasons(d);
    assert(!reasons.length, `a fresh GO still has reasons: ${reasons.join('; ')}`);
    shut(d);
    return `SEALED ${written.sealed}`;
  });

  await checkAsync('a bare directory declines: no latch, no refusal, no [done]', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-stacked-nongit-'));
    const text = await preflightOf(d);
    assert(/^not a project or repository/.test(text), `a bare directory did not decline:\n${text}`);
    assert(!BLOCKED.test(text), `a bare directory latched BLOCKED:\n${text}`);
    assert(!NO_GO.test(text), `a bare directory refused:\n${text}`);

    // A receipt can be written by anything. Without a repository there is no
    // HEAD to bind it to, so it can never be the empty-reasons GO [done] needs.
    writeReceipt(d);
    const reasons = closeReasons(d);
    assert(reasons.length, 'a receipt in a non-git directory read as a GO');
    assert(/not a git repository/.test(reasons.join('; ')), `the missing HEAD was not the reason: ${reasons.join('; ')}`);
    fs.rmSync(path.join(d, ...CLOSE_PATH.split('/')), { force: true });

    const sealed = await seal(d, 'a close without a HEAD has nothing to bind');
    assert(/^not a project or repository/.test(sealed), `a bare directory did not decline:\n${sealed}`);
    assert(!NO_GO.test(sealed), `a bare directory wrote NO-GO:\n${sealed}`);
    assert(!fs.existsSync(closeFile(d)), `a bare directory left a refusal record at ${CLOSE_PATH}`);
    shut(d);
    return 'not a project or repository';
  });

  await checkAsync('a repo with only a structural blocker compacts instead of sealing', async () => {
    const d = tmpRepo();
    fs.mkdirSync(path.join(d, '.stack'), { recursive: true });
    fs.writeFileSync(path.join(d, '.stack', 'config.json'), JSON.stringify({ checks: [] }, null, 2));
    const text = await preflightOf(d);
    assert(/no proving check is configured/.test(text), `the structural blocker was not named:\n${text}`);
    const sealed = await seal(d, 'nothing to land, only compaction remains');
    assert(/compaction is the only remaining act/.test(sealed), `did not compact:\n${sealed}`);
    assert(!NO_GO.test(sealed), `a compact-only close refused:\n${sealed}`);
    assert(!fs.existsSync(closeFile(d)), `a compact-only close left a refusal record at ${CLOSE_PATH}`);
    shut(d);
    return 'compact-only, no refusal';
  });

  // ---------------------------------------------------------------- NO-GO
  await checkAsync('a red check refuses the seal and leaves no GO behind', async () => {
    const d = configuredRepo('node -e "process.exit(3)"');
    writeReceipt(d);
    assert(!closeReasons(d).length, 'the fixture receipt was not a GO before the run');

    const text = await seal(d, 'a red check must not seal');
    assert(NO_GO.test(text), `a red check was sealed:\n${text}`);
    assert(/check is RED/.test(text), `the red check was not the named reason:\n${text}`);
    const refused = refusalOnDisk(d);
    assert(/check is RED/.test(refused.reasons.join('; ')), `the refusal record does not name the red check: ${refused.reasons.join('; ')}`);

    const reasons = closeReasons(d);
    assert(reasons.length, 'a refused close still reads as a GO');
    assert(/the last close was refused/.test(reasons[0]), `the refusal was not named: ${reasons[0]}`);
    shut(d);
    return 'RED, receipt replaced by a refusal';
  });

  await checkAsync('a check that writes a file after the preflight is a NO-GO with no GO receipt', async () => {
    // The check is green and writes dirty.txt: only the post-check recheck can
    // see that the tree the receipt would cover is not the tree that was proved.
    const d = configuredRepo(`node -e "require('fs').writeFileSync('dirty.txt','x')"`);
    assert(GO.test(await preflightOf(d)), 'the fixture was not GO before the checks ran');
    assert(!fs.existsSync(path.join(d, 'dirty.txt')), 'the check ran before the ceremony');

    const text = await seal(d, 'a check that dirties the tree is not evidence');
    assert(NO_GO.test(text), `a check that wrote a file still sealed:\n${text}`);
    assert(/dirty\.txt/.test(text), `the path the check wrote was not named:\n${text}`);
    const refused = refusalOnDisk(d);
    assert(refused.reasons.some((r) => /dirty\.txt/.test(r)), `the refusal record does not name the path the check wrote: ${refused.reasons.join('; ')}`);
    shut(d);
    return 'dirty.txt named, no GO';
  });

  await checkAsync('a check that commits its own work is a NO-GO with no GO receipt', async () => {
    // The check is green and leaves a clean tree: only the HEAD it started at
    // catches a command that committed the tree it was supposed to prove.
    const d = configuredRepo(
      `node -e "require('fs').writeFileSync('x','x');require('child_process').execSync('git add x && git -c user.email=a@b -c user.name=a commit -qm x')"`,
    );
    const before = head(d);
    assert(GO.test(await preflightOf(d)), 'the fixture was not GO before the checks ran');

    const text = await seal(d, 'a check that commits has proved nothing about the tree');
    assert(head(d) !== before, 'the fixture check did not move HEAD, so this case proved nothing');
    assert(NO_GO.test(text), `a check that committed its own work still sealed:\n${text}`);
    assert(/HEAD moved/.test(text), `the moved HEAD was not the named reason:\n${text}`);
    const refused = refusalOnDisk(d);
    assert(refused.reasons.some((r) => /HEAD moved/.test(r)), `the refusal record does not name the moved HEAD: ${refused.reasons.join('; ')}`);
    shut(d);
    return 'HEAD moved named, no GO';
  });

  await checkAsync('a close with no lesson is refused before any work and leaves no GO behind', async () => {
    const d = configuredRepo();
    writeReceipt(d);
    assert(!closeReasons(d).length, 'the fixture receipt was not a GO before the run');

    const text = await seal(d);
    assert(NO_GO.test(text), `a close with no lesson sealed:\n${text}`);
    assert(/needs `lesson`/.test(text), `the missing lesson was not named:\n${text}`);
    assert(/Refused before any work/.test(text), `the refusal does not say it happened before any work:\n${text}`);
    const refused = refusalOnDisk(d);
    assert(refused.reasons.some((r) => /needs `lesson`/.test(r)), `the refusal record does not name the missing lesson: ${refused.reasons.join('; ')}`);
    assert(/the last close was refused/.test(closeReasons(d)[0]), 'the refusal record still read as a GO');
    shut(d);
    return 'refused before work, no GO';
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

  await checkAsync('a head the close never writes is refused for its own reason, not for a missing signature', async () => {
    const d = configuredRepo();
    const sha = head(d);

    // The fixture is signed throughout, so the only reason left is the head. A
    // prefix and a short sha share one reason; a null head is its own.
    const cases = [
      ['a prefix head', { head: sha.slice(0, 7) }, /not a full 40-character lowercase sha/],
      ['a short sha', { head: sha.slice(0, 12) }, /not a full 40-character lowercase sha/],
      ['a null head', { head: null }, /records no HEAD/],
    ];
    for (const [label, options, reason] of cases) {
      writeReceipt(d, options);
      const reasons = closeReasons(d);
      assert(reasons.length === 1, `${label} drew ${reasons.length} reasons, not the one under test: ${reasons.join('; ')}`);
      assert(reason.test(reasons[0]), `${label} was not refused for its own reason: ${reasons[0]}`);
    }
    shut(d);
    return 'prefix, short and null refused by name';
  });

  await checkAsync('a signed GO edited by one byte is refused for its signature, not its shape', async () => {
    const d = configuredRepo();
    writeReceipt(d);
    assert(!closeReasons(d).length, `the signed fixture is not a GO: ${closeReasons(d).join('; ')}`);

    // One byte: the same receipt with a capital letter in a field no other rule
    // reads, so the signature is the only gate that can still refuse it.
    const raw = fs.readFileSync(closeFile(d), 'utf8');
    const tampered = raw.replace('a fixture receipt', 'A fixture receipt');
    assert(tampered !== raw, 'the tamper changed nothing, so this case would prove nothing');
    fs.writeFileSync(closeFile(d), tampered);

    const reasons = closeReasons(d);
    assert(reasons.length === 1, `an edited receipt drew ${reasons.length} reasons, not the signature alone: ${reasons.join('; ')}`);
    assert(/no valid signature: the body does not match `sig`/.test(reasons[0]), `the signature was not the named reason: ${reasons[0]}`);
    shut(d);
    return 'one byte, signature named';
  });

  await checkAsync('an edit after a GO makes the receipt stale, and op=show says so', async () => {
    const d = configuredRepo();
    const text = await seal(d, 'a GO covers the tree the checks proved and nothing else');
    assert(GO.test(text), `the fixture did not seal:\n${text}`);
    assert(!closeReasons(d).length, `a fresh GO has reasons: ${closeReasons(d).join('; ')}`);

    // The receipt was written for a clean tree. One touch outside .stack is an
    // edit no check covered, so [done] would be stale the moment it is read.
    fs.writeFileSync(path.join(d, 'after-go.ts'), 'export const later = 1;\n');
    const reasons = closeReasons(d);
    assert(reasons.length, 'an edited tree still read as a GO');
    assert(/outside \.stack/.test(reasons.join('; ')), `the edit was not the reason: ${reasons.join('; ')}`);

    const shown = await runIn(d, 'close', { op: 'show' });
    assert(NO_GO.test(shown), `op=show read a stale receipt as GO:\n${shown}`);
    assert(/Not valid at HEAD|outside \.stack/.test(shown), `the staleness was not named:\n${shown}`);
    shut(d);
    return 'GO, then stale after one edit';
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

  await checkAsync('a landed brief is blocked by a FAIL audit, and only a later PASS clears it', async () => {
    const d = configuredRepo();
    writeIndex(d, [{ id: 'audit-gate', status: 'landed' }]);

    // No line: landed and unaudited is the same blocker.
    const none = await preflightOf(d);
    assert(BLOCKED.test(none), `a landed brief with no AUDIT was not a blocker:\n${none}`);
    assert(/landed with no AUDIT line naming it/.test(await blockersOf(d)), 'an unaudited landing is not a named blocker');

    // A FAIL is a verdict: it blocks until a later line says PASS.
    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: 'audit-gate: FAIL, three bypasses stand' });
    const failed = await preflightOf(d);
    assert(BLOCKED.test(failed), `a FAIL audit did not block the close:\n${failed}`);
    assert(/latest AUDIT for audit-gate is FAIL/.test(await blockersOf(d)), 'a FAIL audit is not a named blocker');

    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: 'audit-gate: PASS, the bypasses are closed' });
    const passed = await preflightOf(d);
    assert(GO.test(passed), `a later PASS did not clear the FAIL:\n${passed}`);
    shut(d);
    return 'no line blocks, FAIL blocks, PASS clears';
  });

  await checkAsync('a PASS verdict clears a hyphenated seam, even when the id says fail', async () => {
    const d = configuredRepo();
    writeIndex(d, [
      { id: 'pass-gate', status: 'landed' },
      { id: 'fail-gate', status: 'landed' },
    ]);
    const sha = head(d);

    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: `pass-gate@${sha} PASS` });
    const one = await blockersOf(d);
    assert(!/pass-gate landed with no AUDIT/.test(one), `the pass-gate audit did not name its seam: ${one}`);
    assert(/fail-gate landed with no AUDIT/.test(one), `the unaudited fail-gate was not named: ${one}`);

    // The id contains `fail`; only the verdict word may decide, so this clears.
    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: `fail-gate@${sha} PASS` });
    const text = await preflightOf(d);
    assert(GO.test(text), `a PASS under a hyphenated fail-gate id did not clear it:\n${text}`);
    assert(!/ambiguous/.test(await blockersOf(d)), 'a PASS inside a hyphenated id was read as two verdicts');
    shut(d);
    return 'pass-gate@sha PASS and fail-gate@sha PASS both cleared';
  });

  await checkAsync('an inconclusive audit and a FAIL audit block a hyphenated seam', async () => {
    const d = configuredRepo();
    writeIndex(d, [
      { id: 'pass-gate', status: 'landed' },
      { id: 'fail-gate', status: 'landed' },
    ]);
    const sha = head(d);

    // `pass` is the id, not a verdict: the line says neither word.
    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: 'pass-gate: inconclusive, needs work' });
    await runIn(d, 'ledger', { op: 'log', kind: 'AUDIT', text: `fail-gate@${sha} FAIL` });

    const text = await preflightOf(d);
    assert(BLOCKED.test(text), `an inconclusive and a failed audit were GO:\n${text}`);
    const blockers = await blockersOf(d);
    assert(
      /the latest AUDIT for pass-gate is ambiguous: it says neither PASS nor FAIL/.test(blockers),
      `the word inside the id was read as a verdict: ${blockers}`,
    );
    assert(/the latest AUDIT for fail-gate is FAIL/.test(blockers), `the FAIL on fail-gate was not the blocker: ${blockers}`);
    shut(d);
    return 'inconclusive is ambiguous, FAIL is FAIL';
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
    const written = JSON.parse(fs.readFileSync(closeFile(d), 'utf8'));
    const shown = await runIn(d, 'close', { op: 'show' });
    assert(GO.test(shown) && shown.includes(written.receipt_id), `a valid receipt did not read as itself:\n${shown}`);
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
