const readline = require("node:readline");
if (process.argv[3]) require("node:fs").writeFileSync(process.argv[3], String(process.pid));
if (process.argv[2] === "hang") {
  setInterval(() => {}, 1000);
} else {
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const m = JSON.parse(line);
    if (!["initialize", "initialized", "account/rateLimits/read", "account/read"].includes(m.method)) process.exit(2);
    const result = m.id === 0 ? {} : m.id === 1 ? {
      rateLimitsByLimitId: { codex: { limitId: "codex",
        primary: { windowDurationMins: 300, usedPercent: 20, resetsAt: 2000000000 },
        secondary: { windowDurationMins: 10080, usedPercent: 40, resetsAt: 2000000000 },
      } },
    } : { account: { type: "chatgpt", planType: "plus" } };
    if (m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result }) + "\n");
  });
}
