#!/usr/bin/env node
// check-docs.selftest.mjs - prove the documentation gate can go red, offline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const checker = path.join(import.meta.dirname, "check-docs.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-selftest-"));
let fail = 0;
try {
  const bad = path.join(temp, "bad.md");
  const clean = path.join(temp, "clean.md");
  fs.writeFileSync(bad, "# Bad\n\nSee `missing/dir/file.ts`.\n");
  fs.writeFileSync(clean, "# Clean\n\nSee `README.md`.\n");

  const badRun = spawnSync(process.execPath, [checker, "--file", bad], { encoding: "utf8" });
  console.log(`negative control (bad path): exit=${badRun.status}`);
  if (badRun.status === 0) {
    console.log("FAIL: a missing path exited 0");
    fail++;
  }
  if (!badRun.stdout.includes("missing/dir/file.ts")) {
    console.log("FAIL: the bad token was not named");
    fail++;
  }

  const cleanRun = spawnSync(process.execPath, [checker, "--file", clean], { encoding: "utf8" });
  console.log(`positive control (clean path): exit=${cleanRun.status}`);
  if (cleanRun.status !== 0) {
    console.log("FAIL: the clean fixture did not exit 0");
    fail++;
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`selftest failed=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
