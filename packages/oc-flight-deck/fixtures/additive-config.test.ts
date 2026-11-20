import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/tui/config.js";
import { parseJsonc } from "../src/tui/file-config.js";
import { sidebarLines } from "../src/tui/presentation.js";

// The additive promise, enforced rather than promised: a config that worked
// before these slices still loads with no issues and draws the same bytes.
describe("additive configuration", () => {
  test("a pre-change config loads and renders identically", async () => {
    const text = await readFile(join(import.meta.dir, "pre-change-config.jsonc"), "utf8");
    const { config, issues } = resolveConfig(parseJsonc(text));
    expect(issues).toEqual([]);
    expect(config.sidebar.persist).toBe(true);
    expect(config.sidebar.placeholder).toBe("—");

    const lines = sidebarLines(config, {
      status: "idle",
      agent: "build",
      model: { id: "gpt-5", variant: "high" },
      cost: 0.25,
      costKind: "exact",
      tree: { cost: 1.75, count: 2, kind: "exact", tokens: {} },
      project: { cost: 3.5, count: 4 },
      tokens: { input: 1200, output: 340, cache: { read: 9000, write: 100 } },
      context: { used: 218_000, limit: 1_000_000 },
      perms: { count: 1, action: "bash" },
      elapsedMs: 2 * 3_600_000 + 14 * 60_000,
      tps: { rt: 106.3, avg: 41.4, ttft: 1.23 },
    });

    expect(lines).toEqual([
      "status    ○ idle",
      "agent     build",
      "model     gpt-5 · high",
      "cost      $0.250",
      "total     $1.75 · 2 subagents",
      "project   $3.50 · 4 sessions",
      "tokens    1k in · 340 out",
      "cache     88% hit · 9k read",
      "context   ██░░░░░░░░ ~22%",
      "perms     bash",
      "elapsed   2h 14m 00s",
      "tps       106 tok/s · 1.2s ttft",
    ]);
  });
});
