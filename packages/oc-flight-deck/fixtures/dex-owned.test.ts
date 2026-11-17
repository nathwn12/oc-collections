import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedProcess } from "../src/tui/owned-process.js";
import { readCodex } from "../src/tui/codex-quota.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFile(path: string) {
  for (let i = 0; i < 150 && !existsSync(path); i++) await sleep(100);
  expect(existsSync(path)).toBe(true);
  return Number(readFileSync(path, "utf8"));
}
async function gone(pid: number) {
  for (let i = 0; i < 50; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(100);
  }
  throw new Error(`owned fixture still alive: ${pid}`);
}

test.skipIf(process.platform !== "win32")("Windows job reaps a detached descendant when its supervisor is killed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-job-"));
  const command = ownedProcess(process.execPath, [join(import.meta.dir, "dex-owned-fixture.cjs"), "tree", directory]);
  const child = spawn(command.command, command.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const native = await waitFile(join(directory, "native"));
    const descendant = await waitFile(join(directory, "descendant"));
    child.kill("SIGKILL");
    await gone(child.pid!);
    await gone(native);
    await gone(descendant);
  } finally { child.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
}, 25000);

test.skipIf(process.platform !== "win32")("Windows job reaps its private server and detached descendant after owner crash", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flight-deck-owner-"));
  const owner = spawn(process.execPath, [join(import.meta.dir, "dex-owned-fixture.cjs"), "owner", directory], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const supervisor = await waitFile(join(directory, "supervisor"));
    const native = await waitFile(join(directory, "native"));
    const descendant = await waitFile(join(directory, "descendant"));
    owner.kill("SIGKILL");
    await gone(owner.pid!);
    await gone(supervisor);
    await gone(native);
    await gone(descendant);
  } finally { owner.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
}, 25000);

test.skipIf(process.platform !== "win32")("Windows job reaps remaining descendants after successful quota and timeout", async () => {
  for (const mode of ["tree-success", "tree"]) {
    const directory = mkdtempSync(join(tmpdir(), "flight-deck-request-"));
    try {
      const command = ownedProcess(process.execPath, [join(import.meta.dir, "dex-owned-fixture.cjs"), mode, directory]);
      const pending = readCodex(undefined, { ...command, timeoutMs: mode === "tree" ? 4000 : 12000 });
      const native = await waitFile(join(directory, "native"));
      const descendant = await waitFile(join(directory, "descendant"));
      const result = await pending;
      if (mode === "tree-success") expect(result?.account).toEqual({ type: "chatgpt", planType: "plus" });
      else expect(result).toBeUndefined();
      await gone(native);
      await gone(descendant);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}, 30000);
