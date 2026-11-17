const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [mode, directory] = process.argv.slice(2);
if (mode === "owner") {
  const { ownedProcess } = require("../src/tui/owned-process.ts");
  const command = ownedProcess(process.execPath, [__filename, "tree", directory]);
  const supervisor = spawn(command.command, command.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  writeFileSync(join(directory, "supervisor"), String(supervisor.pid));
} else if (mode === "tree" || mode === "tree-success") {
  writeFileSync(join(directory, "native"), String(process.pid));
  spawn(process.execPath, [__filename, "descendant", directory], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
} else {
  writeFileSync(join(directory, "descendant"), String(process.pid));
}
if (mode === "tree-success") {
  const ready = setInterval(() => {
    if (!require("node:fs").existsSync(join(directory, "descendant"))) return;
    clearInterval(ready);
    require("./dex-proxy-fixture.cjs");
    process.stdin.on("end", () => process.exit(0));
  }, 10);
} else {
  setInterval(() => {}, 1000);
}
