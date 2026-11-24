'use strict';
//
// Settings contracts. The shim owns a minimal first-run config and nothing
// else. It never reads, merges into or rewrites a config that already exists.
//

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const settings = require('../lib/settings.js');

function temporary(t, prefix = 'rea-shim-settings-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the config directory is stable under the version-independent root', () => {
  const root = path.join(os.tmpdir(), 'rea-shim-root');
  assert.equal(settings.configDirFor(root), path.join(root, 'config'));
  assert.equal(settings.configPathFor(root), path.join(root, 'config', 'config.toml'));
});

test('a new config contains only auto_mode=false and uses an exclusive create', (t) => {
  const root = temporary(t);
  const result = settings.ensureFirstRunSettings(root);
  assert.equal(result.created, true);
  assert.equal(result.path, settings.configPathFor(root));
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'auto_mode = false\n');
  assert.ok(fs.statSync(result.path).isFile());
});

test('an existing config is never written, merged or reformatted', (t) => {
  const root = temporary(t);
  const file = settings.configPathFor(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = 'version = 3\nauto_mode = true\n[engines]\n';
  fs.writeFileSync(file, original);
  const before = fs.statSync(file);

  let writes = 0;
  const result = settings.ensureFirstRunSettings(root, {
    writeFile: () => { writes += 1; throw new Error('must not write an existing config'); },
  });
  assert.equal(result.created, false);
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.equal(fs.statSync(file).size, before.size);
});

test('a config that appears during the exclusive create is preserved, not overwritten', (t) => {
  const root = temporary(t);
  const file = settings.configPathFor(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = 'auto_mode = true\n';
  const result = settings.ensureFirstRunSettings(root, {
    writeFile: () => { fs.writeFileSync(file, original); throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
  });
  assert.equal(result.created, false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('launch env pins the native config-dir override and removes every inherited spelling', () => {
  const env = settings.launchEnv(
    path.join(os.tmpdir(), 'rea-shim-root'),
    {
      PATH: 'C:\\original',
      CRAFT_ANYTHING_CONFIG_DIR: 'C:\\stale',
      Craft_Anything_Config_Dir: 'C:\\stale-mixed',
      craft_anything_config_dir: 'C:\\stale-lower',
    },
  );
  const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'craft_anything_config_dir');
  assert.deepEqual(keys, ['CRAFT_ANYTHING_CONFIG_DIR']);
  assert.equal(env.CRAFT_ANYTHING_CONFIG_DIR, settings.configDirFor(path.join(os.tmpdir(), 'rea-shim-root')));
  assert.equal(env.PATH, 'C:\\original');
});
