const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
if (process.argv[2] === "leaf") {
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [__filename, "leaf"], { windowsHide: true, stdio: "ignore" });
  writeFileSync(process.argv[2], String(child.pid));
  if (process.argv[3] === "exit") process.exit(0);
  setInterval(() => {}, 1000);
}
