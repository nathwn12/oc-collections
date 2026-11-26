import { expect, test } from "bun:test";
import { scopeFromMessage, newestUserMessage } from "../refresh.js";

const userMsg = (text, extra = {}) => ({ role: "user", text, ...extra });

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
    { role: "assistant", text: "working" },
    userMsg("newest request"),
    userMsg("older request"),
  ];
  expect(newestUserMessage(rows)?.text).toBe("newest request");
});

test("newestUserMessage uses timestamps when rows are not ordered", () => {
  const rows = [
    userMsg("later", { time: { created: 20 } }),
    userMsg("earlier", { time: { created: 10 } }),
  ];
  expect(newestUserMessage(rows)?.text).toBe("later");
});

test("newestUserMessage unwraps a data response and handles no user", () => {
  expect(newestUserMessage({ data: [userMsg("wrapped")] })?.text).toBe("wrapped");
  expect(newestUserMessage([{ role: "assistant", text: "x" }])).toBeUndefined();
  expect(newestUserMessage(undefined)).toBeUndefined();
});
