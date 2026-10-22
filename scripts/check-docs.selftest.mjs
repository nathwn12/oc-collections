#!/usr/bin/env node
// check-docs.selftest.mjs - prove the documentation gate can go red, offline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const checker = path.join(import.meta.dirname, "check-docs.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-selftest-"));
const ignoredDir = path.join(ROOT, "packages/oc-bifrost/dist");
const ignoredFile = path.join(ignoredDir, "check-docs-fixture.md");
let createdIgnoredDir = false;
let fail = 0;
try {
  // 1. The real tree passes (run before the ignored fixture creates dist/).
  const realRun = spawnSync(process.execPath, [checker], { cwd: ROOT, encoding: "utf8" });
  const summary = (realRun.stdout || "").trim().split(/\r?\n/).pop();
  console.log(`real tree: exit=${realRun.status}; ${summary}`);
  if (realRun.status !== 0) {
    console.log("FAIL: the real tree did not pass");
    fail++;
  }

  // 2. Missing path that git ignores: build output, so it passes.
  createdIgnoredDir = !fs.existsSync(ignoredDir);
  fs.mkdirSync(ignoredDir, { recursive: true });
  fs.writeFileSync(ignoredFile, "# Ignored\n\nSee `missing.ts`.\n");
  const ignoredRun = spawnSync(process.execPath, [checker, "--file", ignoredFile], { encoding: "utf8" });
  console.log(`ignored missing path: exit=${ignoredRun.status}`);
  if (ignoredRun.status !== 0) {
    console.log("FAIL: a git-ignored missing path did not pass");
    fail++;
  }

  // 3. Missing path that is not ignored: a real broken link, so it fails.
  const bad = path.join(temp, "bad.md");
  fs.writeFileSync(bad, "# Bad\n\nSee `missing/dir/file.ts`.\n");
  const badRun = spawnSync(process.execPath, [checker, "--file", bad], { encoding: "utf8" });
  console.log(`non-ignored missing path: exit=${badRun.status}`);
  if (badRun.status === 0) {
    console.log("FAIL: a missing path exited 0");
    fail++;
  }
  if (!badRun.stdout.includes("missing/dir/file.ts")) {
    console.log("FAIL: the bad token was not named");
    fail++;
  }
} finally {
  fs.rmSync(ignoredFile, { force: true });
  if (createdIgnoredDir) {
    try { fs.rmdirSync(ignoredDir); } catch {}
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`selftest failed=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
