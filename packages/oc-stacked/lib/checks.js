// The proving commands, in one place: what is configured, one run bound to the
// HEAD it ran at, and what a recorded run proves. Split out of lib/tools.js so
// the check tool, the landing gate and the close ceremony share one runner.
import path from 'node:path';
import { commandAsync } from './exec.js';
import { branch, head } from './git.js';
import { config, isCorruptConfig } from './state.js';
import { stamps } from './text.js';

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** The configured checks, with corruption named instead of silently empty. */
export function configuredChecks(dir) {
  const cfg = config(dir);
  if (isCorruptConfig(cfg)) return { cfg, corrupt: true, all: [] };
  const all = Array.isArray(cfg.checks) ? cfg.checks.filter((c) => c && c.command) : [];
  return { cfg, corrupt: false, all };
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
  for (const c of chosen) {
    const r = await commandAsync(c.command, {
      cwd: str(c.cwd) ? path.join(dir, str(c.cwd)) : dir,
      timeout: Number(c.timeout) > 0 ? Number(c.timeout) : 180000,
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
  return { at: stamps().iso, head: before, headAfter: head(dir), branch: branch(dir), results };
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
  // HEAD is read on both sides of the run: a check that commits changes the
  // tree the plugin is about to seal, so its green is not evidence for any tree.
  if (record.headAfter && record.head && record.headAfter !== record.head) {
    reasons.push(
      `HEAD moved during the check run (before ${record.head}, after ${record.headAfter}); the result is not bound to a tree.`,
    );
  }
  return reasons;
}
