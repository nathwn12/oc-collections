// A durable high-water ledger for the lifetime family cost.
//
// The host's family roll-up is exact while the host holds it, but pruning old
// messages or restarting can make it shrink. The lifetime row is a high-water
// mark: it never goes backwards. A single small JSON file under the user's data
// directory remembers the highest figure seen for each family root. Every fs
// failure is swallowed — a broken or unwritable ledger must never break the
// rail — and no entry is ever deleted or expired.
//
// This is read on every 100 ms tick, so a read only stats the file (mtime +
// size) and re-parses when it moved, and a raised figure is coalesced into one
// write off the render path instead of one rewrite per climb.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** How long a raised figure is held before its single coalesced write. */
const WRITE_DELAY_MS = 250;

type Values = Record<string, number>;

export interface LifetimeTotals {
  /** Highest figure known for `id`, or `undefined` when none has been seen. */
  readonly read: (id: string) => number | undefined;
  /** Raise `id` to `value` when it is higher than everything already known. */
  readonly record: (id: string, value: number) => void;
  /** Write any coalesced figures now; safe to call with nothing pending. */
  readonly flush: () => void;
}

export interface LifetimeTotalsOptions {
  /**
   * Ledger path. Defaults to
   * `~/.local/share/opencode/flight-deck/totals.json`; tests pass a temp dir.
   */
  readonly path?: string;
}

/** The shipped ledger path, under the user's data directory. */
export function defaultLifetimeTotalsPath(): string {
  return join(homedir(), ".local", "share", "opencode", "flight-deck", "totals.json");
}

/** Cheap change probe: mtime + size, or `undefined` when unstatable. */
function signatureOf(path: string): string | undefined {
  try {
    const stats = statSync(path);
    return stats.isFile() ? `${stats.mtimeMs}:${stats.size}` : undefined;
  } catch {
    return undefined;
  }
}

/** Parse only when the probe says the file moved; a bad file is an empty one. */
function parseOf(path: string): Values {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const values: Values = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) values[id] = value;
    }
    return values;
  } catch {
    // A corrupt or unreadable file is treated as empty, never thrown on.
    return {};
  }
}

/**
 * Open the ledger. `path` is the only option; an absent or unreadable file is
 * an empty ledger, never an error. The in-process map is a second high-water:
 * a host that drops messages mid-session cannot shrink `read()` either.
 */
export function createLifetimeTotals(options: LifetimeTotalsOptions = {}): LifetimeTotals {
  const path = options.path ?? defaultLifetimeTotalsPath();
  const held = new Map<string, number>();

  let cached: Values = {};
  let signature: string | undefined;
  let probed = false;

  // Another OpenCode process may have raised the file since our last tick, so
  // the stat still runs on every read — but the file is opened and parsed only
  // when its mtime or size actually moved.
  const storedValues = (): Values => {
    const current = signatureOf(path);
    if (probed && current === signature) return cached;
    probed = true;
    signature = current;
    cached = current === undefined ? {} : parseOf(path);
    return cached;
  };

  let pending = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const writeAll = (values: Values): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(values));
      renameSync(temporary, path);
      // Our own rename is a change too: adopt it so the next read does not
      // re-parse the file we just wrote.
      cached = values;
      signature = signatureOf(path);
      probed = true;
    } catch {
      // Persistence is best-effort: the in-process high-water still holds.
    }
  };

  const flush = (): void => {
    timer = undefined;
    if (pending.size === 0) return;
    const raised = pending;
    pending = new Map();
    // Merge into the latest on-disk values: never delete or prune an entry
    // another process wrote while our write was pending.
    const values = storedValues();
    let changed = false;
    for (const [id, value] of raised) {
      if (value > (values[id] ?? 0)) {
        values[id] = value;
        changed = true;
      }
    }
    if (changed) writeAll(values);
  };

  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(flush, WRITE_DELAY_MS);
    // A best-effort write must not keep the host process alive on exit.
    timer.unref?.();
  };

  return {
    read(id) {
      const stored = storedValues()[id];
      const memory = held.get(id);
      if (stored === undefined && memory === undefined) return undefined;
      return Math.max(stored ?? 0, memory ?? 0);
    },
    record(id, value) {
      // A non-finite or non-positive figure is not a spend and cannot raise a
      // high-water mark.
      if (!Number.isFinite(value) || value <= 0) return;
      const previous = Math.max(held.get(id) ?? 0, storedValues()[id] ?? 0);
      if (value <= previous) return;
      held.set(id, value);
      // The row shows the new figure immediately; the write happens once, off
      // this render, so a climbing cost does not rewrite the ledger per tick.
      pending.set(id, value);
      schedule();
    },
    flush,
  };
}
