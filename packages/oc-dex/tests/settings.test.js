import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SETTINGS_FILE, pluginDirectory, readSettings } from "../src/settings.js";

function directoryWith(text) {
  const directory = mkdtempSync(join(tmpdir(), "oc-dex-settings-"));
  if (text !== undefined) writeFileSync(join(directory, SETTINGS_FILE), text);
  return directory;
}

test("an absent standalone config means defaults, not an error", () => {
  expect(readSettings(directoryWith())).toEqual({});
});

test("discovers the plugin folder itself, so no argument is needed", () => {
  expect(pluginDirectory().endsWith("oc-dex")).toBe(true);
  expect(readSettings()).toEqual({});
});

test("reads a standalone config next to the plugin", () => {
  const directory = directoryWith(JSON.stringify({ progress: "detailed", heartbeatSeconds: 30 }));
  expect(readSettings(directory)).toEqual({ progress: "detailed", heartbeatSeconds: 30 });
});

test("a broken standalone config fails at setup instead of being ignored", () => {
  expect(() => readSettings(directoryWith("{ nope"))).toThrow(/not valid JSON/);
  expect(() => readSettings(directoryWith("[]"))).toThrow(/JSON object/);
  expect(() => readSettings(directoryWith("null"))).toThrow(/JSON object/);
});
