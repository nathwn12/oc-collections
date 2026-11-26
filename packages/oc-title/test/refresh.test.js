import { expect, test } from "bun:test";
import { scopeFromMessage, newestUserMessage } from "../refresh.js";

const userMsg = (text, extra = {}) => ({ type: "user", text, time: { created: 2 }, ...extra });

test("scopeFromMessage takes a user text message", () => {
  expect(scopeFromMessage(userMsg("Fix VST3 Audio"))).toBe("Fix VST3 Audio");
});

test("scopeFromMessage collapses whitespace and trims", () => {
  expect(scopeFromMessage(userMsg("  fix\n  the   board  "))).toBe("fix the board");
});

test("scopeFromMessage returns nothing for an empty or tool-only message", () => {
  expect(scopeFromMessage(userMsg(""))).toBeUndefined();
  expect(scopeFromMessage(userMsg("   "))).toBeUndefined();
  expect(scopeFromMessage(userMsg("", { tools: [{ name: "shell" }] }))).toBeUndefined();
  expect(scopeFromMessage(userMsg("", { parts: [{ type: "tool", tool: "shell" }] }))).toBeUndefined();
});

test("scopeFromMessage reads text parts and ignores tool parts", () => {
  expect(scopeFromMessage(userMsg("", {
    parts: [
      { type: "text", text: "refactor " },
      { type: "tool", tool: "read" },
      { type: "text", text: "the writer" },
    ],
  }))).toBe("refactor the writer");
});

test("scopeFromMessage refuses a non-user message", () => {
  expect(scopeFromMessage({ role: "assistant", text: "done" })).toBeUndefined();
  expect(scopeFromMessage(null)).toBeUndefined();
});

test("newestUserMessage finds the newest user row in a newest-first list", () => {
  const rows = [
    { type: "assistant", text: "working", time: { created: 3 } },
    userMsg("newest request", { time: { created: 9 } }),
    userMsg("older request", { time: { created: 4 } }),
  ];
  expect(newestUserMessage(rows)?.text).toBe("newest request");
});

test("newestUserMessage uses time.created, not array order", () => {
  const rows = [
    userMsg("newest", { time: { created: 99 } }),
    userMsg("older", { time: { created: 10 } }),
  ];
  expect(newestUserMessage(rows)?.text).toBe("newest");
  expect(newestUserMessage([...rows].reverse())?.text).toBe("newest");
});

test("newestUserMessage refuses an unstamped user row instead of guessing", () => {
  expect(newestUserMessage([{ type: "user", text: "no stamp" }])).toBeUndefined();
  expect(newestUserMessage([userMsg("ok", { time: { created: 1 } }), { type: "user", text: "no stamp" }])).toBeUndefined();
});

test("newestUserMessage unwraps a data response and handles no user", () => {
  expect(newestUserMessage({ data: [userMsg("wrapped")] })?.text).toBe("wrapped");
  expect(newestUserMessage([{ type: "assistant", text: "x", time: { created: 1 } }])).toBeUndefined();
  expect(newestUserMessage(undefined)).toBeUndefined();
});
