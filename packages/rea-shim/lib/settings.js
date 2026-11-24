'use strict';
//
// The only settings the shim owns: a minimal first-run config.
//
// Craft v0.6.1 reads its config directory from CRAFT_ANYTHING_CONFIG_DIR before
// the portable marker beside the executable. The shim points that variable at
// one stable directory under its install root on every launch. When no config
// file is there, it writes exactly one key, auto_mode = false, and leaves every
// other Craft default alone. When a config file already exists, the shim does
// not read, merge into, rewrite or reformat it.
//

const fs = require('node:fs');
const path = require('node:path');

const { CRAFT_SOURCE } = require('./sources.js');
const { ensurePlainDir, lstatOrNull } = require('./support.js');

const CONFIG_DIR_NAME = 'config';
const CONFIG_FILE = 'config.toml';
const FIRST_RUN_TEXT = 'auto_mode = false\n';

function configDirFor(root) {
  return path.join(root, CONFIG_DIR_NAME);
}

function configPathFor(root) {
  return path.join(configDirFor(root), CONFIG_FILE);
}

function removeEnvKey(env, key) {
  const wanted = key.toLowerCase();
  for (const existing of Object.keys(env)) {
    if (existing.toLowerCase() === wanted) delete env[existing];
  }
}

function launchEnv(root, baseEnv = process.env) {
  const env = { ...baseEnv };
  removeEnvKey(env, CRAFT_SOURCE.configEnv);
  env[CRAFT_SOURCE.configEnv] = configDirFor(root);
  return env;
}

function ensureFirstRunSettings(root, options = {}) {
  const lstat = options.lstat || lstatOrNull;
  const mkdir = options.mkdir || ((dir) => ensurePlainDir(dir, 'config directory'));
  const writeFile = options.writeFile || ((file, text) => fs.writeFileSync(file, text, { flag: 'wx' }));
  const dir = configDirFor(root);
  const file = configPathFor(root);
  if (lstat(file)) return { created: false, path: file };
  mkdir(dir);
  try {
    writeFile(file, FIRST_RUN_TEXT);
  } catch (error) {
    // A file created between the check and the exclusive write is the user's
    // config. It is preserved byte for byte.
    if (error && error.code === 'EEXIST') return { created: false, path: file };
    throw error;
  }
  return { created: true, path: file };
}

module.exports = {
  CONFIG_FILE,
  FIRST_RUN_TEXT,
  configDirFor,
  configPathFor,
  ensureFirstRunSettings,
  launchEnv,
};
