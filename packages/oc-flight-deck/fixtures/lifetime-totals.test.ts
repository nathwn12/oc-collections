import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(ledger.read("root")).toBe(2.5);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ root: 2.5 });
  });

  test("a fresh instance reads the same file and keeps the high-water", () => {
    createLifetimeTotals({ path }).record("root", 3.25);
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
    const second = createLifetimeTotals({ path });
    second.record("c", 3);
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
