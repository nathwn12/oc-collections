import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Standalone knobs live next to the plugin so a machine can tune oc_dex without adding an
// entry to opencode.jsonc. `options` on a plugins entry still wins over this file.
export const SETTINGS_FILE = "oc-dex.config.json";

// The plugin folder, found by walking up to the package.json that owns this module, so the
// config file is discovered wherever the folder is linked from.
export function pluginDirectory(start = dirname(fileURLToPath(import.meta.url))) {
  let directory = start;
  for (let depth = 0; depth < 4; depth += 1) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return start;
}

export function readSettings(directory = pluginDirectory(), read = readFileSync) {
  const file = join(directory, SETTINGS_FILE);
  let text;
  try {
    text = read(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${SETTINGS_FILE} is not valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${SETTINGS_FILE} must contain a JSON object`);
  return value;
}
