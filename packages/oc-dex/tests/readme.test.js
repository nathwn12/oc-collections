import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const readme = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");

test("documents the Go-only model allowlist", () => {
  expect(readme).toContain("Use OpenCode Go model IDs");
  expect(readme).toContain("OpenCode Go is the only supported provider.");
  expect(readme).not.toContain("other available providers");
});
