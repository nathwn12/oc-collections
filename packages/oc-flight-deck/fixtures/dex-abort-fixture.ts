import { readCodex } from "../src/tui/codex-quota.js";
const controller = new AbortController();
controller.abort();
await readCodex(controller.signal, { command: "flight-deck-nonexistent-command-7812" });
await new Promise(resolve => setTimeout(resolve, 100));
