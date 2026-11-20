// A durable high-water ledger for the lifetime family cost.
//
// The host's family roll-up is exact while the host holds it, but pruning old
// messages or restarting can make it shrink. The lifetime row is a high-water
// mark: it never goes backwards. A single small JSON file under the user's data
// directory remembers the highest figure seen for each family root. Every fs
// failure is swallowed — a broken or unwritable ledger must never break the
// rail — and no entry is ever deleted or expired.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LifetimeTotals {
  /** Highest figure known for `id`, or `undefined` when none has been seen. */
  readonly read: (id: string) => number | undefined;
  /** Raise `id` to `value` when it is higher than everything already known. */
  readonly record: (id: string, value: number) => void;
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

/**
 * Open the ledger. `path` is the only option; an absent or unreadable file is
 * an empty ledger, never an error. The in-process map is a second high-water:
 * a host that drops messages mid-session cannot shrink `read()` either.
 */
export function createLifetimeTotals(options: LifetimeTotalsOptions = {}): LifetimeTotals {
  const path = options.path ?? defaultLifetimeTotalsPath();
  const held = new Map<string, number>();

  // Re-read on every call: another OpenCode process may have raised the file
  // since our last tick, and we must not lower our answer to its figure.
  const storedValues = (): Record<string, number> => {
    try {
      if (!existsSync(path)) return {};
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      const values: Record<string, number> = {};
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) values[id] = value;
      }
      return values;
    } catch {
      // A corrupt or unreadable file is treated as empty, never thrown on.
      return {};
    }
  };

  const writeAll = (values: Record<string, number>): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(values));
      renameSync(temporary, path);
    } catch {
      // Persistence is best-effort: the in-process high-water still holds.
    }
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
      // Merge into what is on disk: never delete or prune another entry.
      const values = storedValues();
      values[id] = value;
      writeAll(values);
    },
  };
}
