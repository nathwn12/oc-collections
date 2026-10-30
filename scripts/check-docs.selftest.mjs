#!/usr/bin/env node
// check-docs.selftest.mjs - prove the documentation gate can go red, offline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const checker = path.join(import.meta.dirname, "check-docs.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-selftest-"));
const ignoredDir = path.join(ROOT, "packages/oc-bifrost/dist");
const ignoredFile = path.join(ignoredDir, `check-docs-${randomUUID().slice(0, 8)}-fixture.md`);
let createdIgnoredDir = false;
// Front-door asset fixtures live inside a real package tree so the checker sees
// a real nearest package root and its real `files` manifest. Every fixture path
// carries this run's id, so no two runs share a path and a stale file from an
// earlier run is never mistaken for our own.
const runId = `${process.pid}-${randomUUID().slice(0, 8)}`;
const shimDir = path.join(ROOT, "packages/rea-shim");
const shippedReadme = path.join(shimDir, `check-docs-${runId}-shipped-fixture.md`);
const missingReadme = path.join(shimDir, `check-docs-${runId}-missing-asset-fixture.md`);
const unshippedReadme = path.join(shimDir, `check-docs-${runId}-unshipped-asset-fixture.md`);
const unshippedDir = path.join(shimDir, `check-docs-${runId}-unshipped`);
const unshippedAsset = path.join(unshippedDir, "asset.svg");
const unshippedSrc = `check-docs-${runId}-unshipped/asset.svg`;
const otherDir = path.join(shimDir, `check-docs-${runId}-other`);
// Only files this run actually created are ever removed: a pre-existing file is
// never deleted, and an existing file at a fixture path aborts the run (wx)
// rather than being overwritten.
const created = [];
function writeFixture(file, data) {
  fs.writeFileSync(file, data, { flag: "wx" });
  created.push(file);
}
let fail = 0;
try {
  // 0. The fixture writer refuses to overwrite: an existing file at a fixture
  //    path aborts the run instead of being replaced, and is left byte-identical.
  const sentinel = path.join(temp, "exists.md");
  fs.writeFileSync(sentinel, "keep\n");
  let refused = false;
  try { writeFixture(sentinel, "clobber\n"); } catch { refused = true; }
  if (!refused || fs.readFileSync(sentinel, "utf8") !== "keep\n") {
    console.log("FAIL: a fixture write did not refuse an existing file");
    fail++;
  }

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
  writeFixture(ignoredFile, "# Ignored\n\nSee `missing.ts`.\n");
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

  // 4. Front door with a stale pin beside its own package name: the drift that
  //    shipped twice, so it fails and names the offending line.
  const pinned = path.join(temp, "pinned.md");
  fs.writeFileSync(pinned, [
    "# oc-flight-deck",
    "",
    "## Install",
    "",
    "```json",
    '{ "plugins": ["oc-flight-deck@0.20.3"] }',
    "```",
    "",
  ].join("\n"));
  const pinnedRun = spawnSync(process.execPath, [checker, "--file", pinned, "--pkg", "oc-flight-deck"], { encoding: "utf8" });
  console.log(`front door with a pin: exit=${pinnedRun.status}`);
  if (pinnedRun.status === 0) {
    console.log("FAIL: a pinned front-door README exited 0");
    fail++;
  }
  if (!pinnedRun.stdout.includes("oc-flight-deck@0.20.3")) {
    console.log("FAIL: the stale pin was not named");
    fail++;
  }

  // 5. Front door with a relative link: npm has no repo tree to resolve it
  //    against, so it fails.
  const relativeLink = path.join(temp, "relative-link.md");
  fs.writeFileSync(relativeLink, "# oc-flight-deck\n\nSee [the guide](docs/GUIDE.md).\n");
  const relativeRun = spawnSync(process.execPath, [checker, "--file", relativeLink, "--pkg", "oc-flight-deck"], { encoding: "utf8" });
  console.log(`front door with a relative link: exit=${relativeRun.status}`);
  if (relativeRun.status === 0) {
    console.log("FAIL: a relative markdown link exited 0");
    fail++;
  }
  if (!relativeRun.stdout.includes("relative markdown link: docs/GUIDE.md")) {
    console.log("FAIL: the relative link was not named");
    fail++;
  }

  // 6. Front door with prerequisites and an absolute link: a Node floor is not
  //    a pin, so it passes.
  const clean = path.join(temp, "clean.md");
  fs.writeFileSync(clean, [
    "# oc-flight-deck",
    "",
    "Requires Node 22.14.0 and OpenCode 2.1.1 or newer.",
    "",
    "- Guide: <https://github.com/nathwn12/oc-collections/blob/main/packages/oc-flight-deck/docs/GUIDE.md>",
    "",
  ].join("\n"));
  const cleanRun = spawnSync(process.execPath, [checker, "--file", clean, "--pkg", "oc-flight-deck"], { encoding: "utf8" });
  console.log(`front door with prerequisites: exit=${cleanRun.status}`);
  if (cleanRun.status !== 0) {
    console.log(`FAIL: a Node floor and an absolute link did not pass\n${cleanRun.stdout}`);
    fail++;
  }

  // 7. Front door whose footer names the canonical asset the package actually
  //    ships: npm has the file, so the relative <img src> resolves and passes.
  const footer = [
    "# rea-shim",
    "",
    "## Links",
    "",
    "- Guide: <https://github.com/nathwn12/oc-collections/blob/main/packages/rea-shim/docs/GUIDE.md>",
    "",
    "<!-- nathwn12 house footer: identical in every repo. Do not edit. -->",
    '<p align="center"><a href="https://github.com/nathwn12"><img src="assets/signature.svg" width="96" alt="nathwn12" /></a></p>',
    "",
  ].join("\n");
  writeFixture(shippedReadme, footer);
  const shippedRun = spawnSync(process.execPath, [checker, "--file", shippedReadme, "--pkg", "rea-shim"], { encoding: "utf8" });
  console.log(`front door with a shipped relative asset: exit=${shippedRun.status}`);
  if (shippedRun.status !== 0) {
    console.log(`FAIL: a relative image shipped in the package did not pass\n${shippedRun.stdout}`);
    fail++;
  }

  // 8. Same footer, asset absent from disk: npm would render a broken image, so
  //    it fails and names the source.
  writeFixture(missingReadme, footer.replace("assets/signature.svg", "assets/missing-signature.svg"));
  const missingRun = spawnSync(process.execPath, [checker, "--file", missingReadme, "--pkg", "rea-shim"], { encoding: "utf8" });
  console.log(`front door with a missing relative asset: exit=${missingRun.status}`);
  if (missingRun.status === 0) {
    console.log("FAIL: a missing relative image exited 0");
    fail++;
  }
  if (!missingRun.stdout.includes("relative image source: assets/missing-signature.svg")) {
    console.log("FAIL: the missing relative image was not named");
    fail++;
  }

  // 9. Asset present on disk but outside the package's `files` manifest: it is
  //    not in the tarball, so it fails the same way.
  fs.mkdirSync(unshippedDir);
  writeFixture(unshippedAsset, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  writeFixture(unshippedReadme, footer.replace("assets/signature.svg", unshippedSrc));
  const unshippedRun = spawnSync(process.execPath, [checker, "--file", unshippedReadme, "--pkg", "rea-shim"], { encoding: "utf8" });
  console.log(`front door with an unshipped relative asset: exit=${unshippedRun.status}`);
  if (unshippedRun.status === 0) {
    console.log("FAIL: an unshipped relative image exited 0");
    fail++;
  }
  if (!unshippedRun.stdout.includes(`relative image source: ${unshippedSrc}`)) {
    console.log("FAIL: the unshipped relative image was not named");
    fail++;
  }

  // 10. A different image the package really ships is still refused: the relative
  //     exception is the house footer asset alone, not any file `files` covers.
  fs.mkdirSync(otherDir);
  fs.mkdirSync(path.join(otherDir, "assets"));
  writeFixture(path.join(otherDir, "package.json"), '{ "name": "fixture", "files": ["assets/"] }\n');
  writeFixture(path.join(otherDir, "assets/other.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  const otherReadme = path.join(otherDir, "other.md");
  writeFixture(otherReadme, '<p align="center"><img src="assets/other.svg" alt="other" /></p>\n');
  const otherRun = spawnSync(process.execPath, [checker, "--file", otherReadme, "--pkg", "rea-shim"], { encoding: "utf8" });
  console.log(`front door with a non-footer shipped image: exit=${otherRun.status}`);
  if (otherRun.status === 0) {
    console.log("FAIL: a shipped image that is not the house footer asset exited 0");
    fail++;
  }
  if (!otherRun.stdout.includes("relative image source: assets/other.svg")) {
    console.log("FAIL: the non-footer relative image was not named");
    fail++;
  }
} finally {
  for (const f of created) fs.rmSync(f, { force: true });
  try { fs.rmdirSync(unshippedDir); } catch {}
  fs.rmSync(otherDir, { recursive: true, force: true });
  if (createdIgnoredDir) {
    try { fs.rmdirSync(ignoredDir); } catch {}
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log(`selftest failed=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
