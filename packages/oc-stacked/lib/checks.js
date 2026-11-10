// The proving commands, in one place: what is configured, one run bound to the
// HEAD it ran at, and what a recorded run proves. Split out of lib/tools.js so
// the check tool, the landing gate and the close ceremony share one runner.
import fs from 'node:fs';
import path from 'node:path';
import { commandAsync, parse } from './exec.js';
import { branch, head } from './git.js';
import { PATHS, config, isCorruptConfig } from './state.js';
import { stamps } from './text.js';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const DEFAULT_TIMEOUT = 180000;

/**
 * The budget one configured check chose. A configured `timeout` that is not a
 * positive number of milliseconds cannot bound anything, so it is refused by
 * name instead of being replaced with a default that then certifies a green the
 * operator never asked for. A check that omits `timeout` still gets the default.
 */
function checkTimeout(c) {
  if (c.timeout === undefined) return { ms: DEFAULT_TIMEOUT, error: null };
  if (typeof c.timeout === 'number' && Number.isFinite(c.timeout) && c.timeout > 0) return { ms: c.timeout, error: null };
  let shown;
  try {
    shown = JSON.stringify(c.timeout) ?? String(c.timeout);
  } catch {
    shown = String(c.timeout);
  }
  return { ms: null, error: `\`timeout\` is \`${shown}\`, not a positive number of milliseconds` };
}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

/**
 * The unquoted absolute paths a configured command writes where the runner will
 * split them. `parse` is the same splitter every check runs through, so a token
 * that is an absolute path cut at a space is exactly what becomes two arguments:
 * the command that runs is then not the command that was written, and still
 * exits 0. A quoted token keeps its space and is never a finding; a relative
 * path is out of scope.
 */
function splitAbsolutePaths(command, cwd) {
  let parts;
  try {
    parts = parse(command);
  } catch {
    return []; // an unbalanced quote is already a refusal when the command runs
  }
  const found = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const token = parts[i];
    if (!token || token.includes(' ') || !ABSOLUTE_PATH.test(token)) continue;
    let joined = token;
    for (let j = i + 1; j < parts.length; j += 1) {
      const next = parts[j];
      if (!next || next.includes(' ') || next.startsWith('-') || ABSOLUTE_PATH.test(next)) break;
      joined = `${joined} ${next}`;
      if (fs.existsSync(path.resolve(cwd, joined))) {
        found.push(joined);
        break;
      }
      // An extensionless absolute path followed by a path fragment is the same
      // shape whether or not the target exists yet.
      if (!HAS_EXTENSION.test(token) && /[\\/]/.test(next)) {
        found.push(joined);
        break;
      }
    }
  }
  return found;
}

/** Every configured command that would run somewhere other than where it was written. */
function commandProblems(dir, cfg) {
  const problems = [];
  const inspect = (kind, where, command, cwd) => {
    const base = str(cwd) ? path.join(dir, str(cwd)) : dir;
    for (const split of splitAbsolutePaths(str(command), base)) {
      problems.push({ kind, where, command: str(command), split });
    }
  };
  const checks = Array.isArray(cfg?.checks) ? cfg.checks : [];
  checks.forEach((c, i) => {
    if (c && str(c.command)) inspect('check', `checks[${i}]${c.name ? ` (${c.name})` : ''}`, c.command, c.cwd);
  });
  if (cfg?.atlas && str(cfg.atlas.command)) inspect('atlas', 'atlas', cfg.atlas.command, cfg.atlas.cwd);
  return problems;
}

export function commandProblemText(p) {
  return `\`${p.where}\` command \`${p.command.replace(/`/g, '')}\` writes \`${p.split}\` unquoted: the space splits it into separate arguments, so the command that runs is not the command that was written. Quote the path in \`${PATHS.config}\`.`;
}

/** The configured checks, with corruption named instead of silently empty. */
export function configuredChecks(dir) {
  const cfg = config(dir);
  if (isCorruptConfig(cfg)) return { cfg, corrupt: true, all: [], problems: [] };
  const all = Array.isArray(cfg.checks) ? cfg.checks.filter((c) => c && c.command) : [];
  return { cfg, corrupt: false, all, problems: commandProblems(dir, cfg).map(commandProblemText) };
}

/**
 * Run the chosen checks and bind the result to the HEAD it ran at. `head` is
 * read BEFORE the first check and `headAfter` after the last: a check that
 * commits its own work moves the tree it leaves behind, and a result read only
 * at the end would be bound to a tree that never existed when the first check
 * started.
 */
export async function executeChecks(dir, chosen) {
  const before = head(dir);
  const results = [];
  // The atlas command is read by the close ceremony, not by this runner, so its
  // problems are stamped on the record and named by checkRecordReasons: a
  // receipt must not be sealed behind a command that runs somewhere else.
  const cfg = config(dir);
  const atlasProblems = isCorruptConfig(cfg)
    ? []
    : commandProblems(dir, cfg)
        .filter((p) => p.kind === 'atlas')
        .map(commandProblemText);

  for (const c of chosen) {
    const cwd = str(c.cwd) ? path.join(dir, str(c.cwd)) : dir;
    const budget = checkTimeout(c);
    const split = splitAbsolutePaths(str(c.command), cwd);
    if (budget.error || split.length) {
      const why = [
        budget.error,
        split.length
          ? `the command writes \`${split[0]}\` unquoted, so the space splits it into separate arguments`
          : null,
      ]
        .filter(Boolean)
        .join('; ');
      results.push({
        name: c.name || c.command,
        command: c.command,
        ok: false,
        code: budget.error ? 'invalid-timeout' : 'split-path',
        ms: 0,
        tail: `Refused: ${why}.`,
      });
      continue;
    }
    const r = await commandAsync(c.command, {
      cwd,
      timeout: budget.ms,
      env: { ...process.env, CI: process.env.CI ?? '1' },
    });
    results.push({
      name: c.name || c.command,
      command: c.command,
      ok: r.ok,
      code: r.code,
      ms: r.ms,
      tail: r.display.split('\n').slice(-12).join('\n'),
    });
  }
  return {
    at: stamps().iso,
    head: before,
    headAfter: head(dir),
    branch: branch(dir),
    results,
    ...(atlasProblems.length ? { configProblems: atlasProblems } : {}),
  };
}

/**
 * What one recorded check run proves. The gate never trusts a stored record —
 * it runs the checks itself — so the only invariant left is that the record it
 * just made covers every configured check. A short record means the run was cut
 * off; a hand-edited `results: []` is caught by the same comparison.
 */
export function checkRecordReasons(record, configured) {
  const results = record.results;
  const reasons = [];
  if (results.length !== configured.length) {
    reasons.push(`the check run recorded ${results.length} of ${configured.length} checks; a partial result set is not evidence of green.`);
  } else {
    const failed = results.filter((r) => !r.ok);
    if (failed.length) reasons.push(`check is RED: ${failed.map((r) => r.name).join(', ')}.`);
  }
  // A check that never ran cannot be green. Its configuration is the reason, so
  // the reason is named here rather than left as a silent default.
  for (const r of results.filter((x) => x.code === 'invalid-timeout' || x.code === 'split-path')) {
    reasons.push(`check ${r.name} was refused before it ran: ${String(r.tail || '').replace(/^Refused:\s*/, '')}`);
  }
  // HEAD is read on both sides of the run: a check that commits changes the
  // tree the plugin is about to seal, so its green is not evidence for any tree.
  if (record.headAfter && record.head && record.headAfter !== record.head) {
    reasons.push(
      `HEAD moved during the check run (before ${record.head}, after ${record.headAfter}); the result is not bound to a tree.`,
    );
  }
  // A configured atlas command is read by the close ceremony, so its problem is
  // carried on the record the ceremony gates: the seal is refused, not renamed.
  for (const problem of Array.isArray(record.configProblems) ? record.configProblems : []) reasons.push(problem);
  return reasons;
}
