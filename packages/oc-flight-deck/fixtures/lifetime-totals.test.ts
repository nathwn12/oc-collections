import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLifetimeTotals, defaultLifetimeTotalsPath } from "../src/tui/lifetime-totals.js";

// The durable high-water ledger. Each test gets its own directory, so no
// machine config or earlier test can leak into the file under test.

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "flight-deck-totals-"));
  path = join(directory, "nested", "totals.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the lifetime totals ledger", () => {
  test("ships a data-directory path and honours an override", () => {
    expect(defaultLifetimeTotalsPath()).toContain("flight-deck");
    expect(defaultLifetimeTotalsPath()).toMatch(/totals\.json$/);
    const ledger = createLifetimeTotals({ path });
    expect(ledger.read("root")).toBeUndefined();
  });

  test("a first write creates the file and is readable", () => {
    const ledger = createLifetimeTotals({ path });
    ledger.record("root", 1.75);
    ledger.flush();
    expect(existsSync(path)).toBe(true);
    expect(ledger.read("root")).toBe(1.75);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ root: 1.75 });
  });

  test("a higher write wins and a lower write is ignored", () => {
    const ledger = createLifetimeTotals({ path });
    ledger.record("root", 1.75);
    ledger.record("root", 2.5);
    expect(ledger.read("root")).toBe(2.5);
    ledger.record("root", 0.25);
    ledger.record("root", Number.NaN);
    ledger.record("root", -5);
    ledger.flush();
    expect(ledger.read("root")).toBe(2.5);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ root: 2.5 });
  });

  test("a fresh instance reads the same file and keeps the high-water", () => {
    const first = createLifetimeTotals({ path });
    first.record("root", 3.25);
    first.flush();
    const fresh = createLifetimeTotals({ path });
    expect(fresh.read("root")).toBe(3.25);
    // A live figure that shrank after host pruning cannot lower the row.
    fresh.record("root", 0.5);
    expect(fresh.read("root")).toBe(3.25);
  });

  test("entries are never deleted or pruned, even across instances", () => {
    const first = createLifetimeTotals({ path });
    first.record("a", 1);
    first.record("b", 2);
    first.flush();
    const second = createLifetimeTotals({ path });
    second.record("c", 3);
    second.flush();
    expect(second.read("a")).toBe(1);
    expect(second.read("b")).toBe(2);
    expect(second.read("c")).toBe(3);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("a corrupt file does not throw and behaves as an empty ledger", () => {
    const nested = join(directory, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path, "{ this is not json");
    const ledger = createLifetimeTotals({ path });
    expect(() => ledger.read("root")).not.toThrow();
    expect(ledger.read("root")).toBeUndefined();
    expect(() => ledger.record("root", 4.5)).not.toThrow();
    expect(ledger.read("root")).toBe(4.5);
  });

  test("reads are cached behind an mtime/size probe, not a re-parse", () => {
    const nested = join(directory, "nested");
    mkdirSync(nested, { recursive: true });
    const at = new Date(1_700_000_000_000);
    writeFileSync(path, JSON.stringify({ root: 2 }));
    utimesSync(path, at, at);
    const ledger = createLifetimeTotals({ path });

    expect(ledger.read("root")).toBe(2);
    // Same size and mtime: a reader that reopened the file would see 9, but a
    // signature-cached reader keeps what it parsed on the first read.
    writeFileSync(path, JSON.stringify({ root: 9 }));
    utimesSync(path, at, at);
    for (let tick = 0; tick < 10; tick += 1) expect(ledger.read("root")).toBe(2);

    // A real mtime change is the signal to re-read.
    const later = new Date(1_700_000_100_000);
    utimesSync(path, later, later);
    expect(ledger.read("root")).toBe(9);
  });

  test("writes are coalesced off the render path and merge on-disk entries", async () => {
    const ledger = createLifetimeTotals({ path });
    ledger.record("a", 1);
    ledger.record("a", 2);
    ledger.record("b", 3);
    // Nothing is written while the rail renders; the row still shows the high-water.
    expect(existsSync(path)).toBe(false);
    expect(ledger.read("a")).toBe(2);
    expect(ledger.read("b")).toBe(3);

    // Another process adds an entry while our write is pending.
    mkdirSync(join(directory, "nested"), { recursive: true });
    writeFileSync(path, JSON.stringify({ c: 4 }));
    await Bun.sleep(350);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 2, b: 3, c: 4 });
  });

  test("an unwritable target never throws", () => {
    // A directory where the file should be makes both read and rename fail.
    writeFileSync(join(directory, "blocker"), "");
    const blocked = join(directory, "blocker", "totals.json");
    const ledger = createLifetimeTotals({ path: blocked });
    expect(() => ledger.record("root", 9)).not.toThrow();
    // The in-process high-water still holds even without persistence.
    expect(ledger.read("root")).toBe(9);
  });
});
