/**
 * Host-schema proof for oc-harness-setup. Every config shape this package emits
 * is round-tripped through the INSTALLED OpenCode CLI and compared back: the
 * 2.2.0 config schema STRIPS a key it does not know, so a key that disappears
 * from `opencode debug config`'s `info` is a key the host would silently ignore.
 *
 * Facts this file pins (measured against opencode v2.2.0, offline):
 *   - `plugins` is the canonical key; `plugin` / `permission` singular are the
 *     1.x dialect the host migrates away from.
 *   - a `plugins` entry must be a plain specifier STRING; the 1.x
 *     [specifier, options] tuple and any non-string are DROPPED.
 *   - `policies` entries are filtered by a known-action enum: `tool.use`
 *     survives, an unknown action is dropped (`policies: []`).
 *   - `permissions` is an array of {action, resource, effect} and its actions
 *     are NOT filtered.
 *   - `mcp.<name>` and `mcp.servers.<name>` are both accepted; the host
 *     normalizes to `mcp.servers`.
 *
 * Nothing here touches the live user config: every probe writes under
 * os.tmpdir() and reads only its own probe document out of `debug config`.
 * The suite SKIPS when the host on PATH is not 2.2.0 or newer (the shapes
 * cannot be proven against a dialect the package does not target).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PKG_ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(PKG_ROOT, 'bin', 'cli.js');

/* --------------------------- host discovery --------------------------- */

function hostVersion() {
  const r = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) return null;
  // The real 2.2.0 CLI prints `opencode v2.2.0`; a fake on PATH prints a bare
  // version, so this also refuses to grade a test double.
  const m = String(r.stdout || '').trim().match(/^opencode v(\d+)\.(\d+)\.(\d+)/);
  return m ? { raw: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]), minor: Number(m[2]) } : null;
}

const HOST = hostVersion();
const SKIP = !HOST
  ? 'no real OpenCode CLI on PATH (`opencode --version` did not print `opencode vX.Y.Z`) — host shapes UNVERIFIED'
  : HOST.major < 2 || (HOST.major === 2 && HOST.minor < 2)
    ? `host is ${HOST.raw}; this package targets the 2.2.0 config dialect — shapes UNVERIFIED`
    : false;

/* ------------------------- JSONC read (package file) ------------------- */

function stripJsonc(text) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readDistroConfig() {
  return JSON.parse(stripJsonc(readFileSync(path.join(PKG_ROOT, 'opencode.jsonc'), 'utf8')));
}

/* --------------------------- host round-trip -------------------------- */

// Write `configObject` as a PROJECT config (cwd) — the one surface 2.2.0 reads
// from an arbitrary directory with no env var and no touch to the live config —
// then ask the host to parse it and hand back the document it actually kept.
function probeHost(configObject) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oc-host-probe-'));
  const cfg = path.join(dir, 'opencode.json');
  writeFileSync(cfg, JSON.stringify(configObject, null, 2));
  const r = spawnSync('opencode', ['debug', 'config'], { cwd: dir, encoding: 'utf8', timeout: 180000 });
  assert.equal(
    r.status, 0,
    `opencode debug config (${HOST.raw}) exited ${r.status} on a probe config\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`
  );
  const docs = JSON.parse(r.stdout || 'null');
  const doc = Array.isArray(docs)
    ? docs.find((d) => d.type === 'document' && path.resolve(String(d.path)) === path.resolve(cfg))
    : null;
  assert.ok(doc, `host listed no document source for the probe config; sources: ${JSON.stringify((docs || []).map((d) => d.path))}`);
  return { dir, info: doc.info ?? {} };
}

// What the schema LOST: a key it did not keep, or array entries it discarded.
// A scalar the host REWRITES is the opposite of a loss — 2.2.0 normalizes what
// it understood (`model: "p/m"` → `{providerID, model}`, `warming.interval`
// "5 minutes" → "300000 millis"), so a changed scalar is reported separately
// and is never a failure.
function dropped(inNode, outNode, at = '$', hits = []) {
  if (Array.isArray(inNode)) {
    if (!Array.isArray(outNode)) { hits.push(`${at} (array rejected)`); return hits; }
    if (inNode.length !== outNode.length) hits.push(`${at} (${inNode.length} entries -> ${outNode.length})`);
    inNode.forEach((v, i) => dropped(v, outNode[i], `${at}[${i}]`, hits));
    return hits;
  }
  if (inNode && typeof inNode === 'object') {
    if (!outNode || typeof outNode !== 'object' || Array.isArray(outNode)) {
      hits.push(`${at} (object rejected)`);
      return hits;
    }
    for (const k of Object.keys(inNode)) {
      if (!(k in outNode)) { hits.push(`${at}.${k}`); continue; }
      dropped(inNode[k], outNode[k], `${at}.${k}`, hits);
    }
    return hits;
  }
  return hits; // scalar: a rewrite is normalization, not loss
}

/* ----------------------- fake host for the install -------------------- */

// The installer must reach a 2.2.0-shaped host while the probe below reaches
// the real one, so the CLI child gets a PATH whose `opencode` is this shim.
// Outputs mirror the real v2.2.0 commands the installer and doctor consume:
// `--version` prints `v2.2.0`, `plugin list` prints the ID/VERSION/SOURCE table.
function writeFakeOpencode(binDir) {
  const lines = [
    "const cfg = process.env.FAKE_OPENCODE_CONFIG ?? '';",
    'const a = process.argv.slice(2);',
    "const out = (s) => process.stdout.write(s + '\\n');",
    "if (a[0] === '--version') out('opencode v' + (process.env.FAKE_OPENCODE_VERSION ?? '2.2.0'));",
    "else if (a[0] === 'debug' && a[1] === 'paths') out('config = ' + cfg);",
    "else if (a[0] === 'debug' && a[1] === 'config') out(JSON.stringify([{ type: 'document', path: cfg + '/opencode.jsonc' }]));",
    "else if (a[0] === 'debug' && a[1] === 'agents') out(JSON.stringify([{ id: 'orchestrator', name: 'Orchestrator', mode: 'primary' }]));",
    "else if (a[0] === 'plugin' && a[1] === 'list') {",
    "  const rows = (process.env.FAKE_OPENCODE_PLUGINS ?? '').split(/[,\\s]+/).filter(Boolean);",
    "  if (!rows.length) out('No plugins found');",
    "  else { out('ID                 VERSION  SOURCE'); for (const n of rows) out(n + '  2.2.0  ' + n); }",
    '}',
    "else if (a[0] === 'mcp' && a[1] === 'list') out('No MCP servers configured');",
    "else { process.stderr.write('fake opencode: unknown args ' + a.join(' ') + '\\n'); process.exitCode = 1; }",
  ];
  writeFileSync(path.join(binDir, 'fake-opencode.mjs'), lines.join('\n'));
  writeFileSync(path.join(binDir, 'opencode.cmd'), '@echo off\r\nnode "%~dp0fake-opencode.mjs" %*\r\n');
}

// PATH minus every directory holding a real opencode, so the shim is the only
// `opencode` the installer can reach (a real exe would create its config dir).
function fakePath(fakeBin) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter((d) => {
    if (!d) return false;
    for (const n of ['opencode.exe', 'opencode.cmd', 'opencode']) {
      try {
        if (statSync(path.join(d, n)).isFile()) return false;
      } catch { /* absent — keep the dir */ }
    }
    return true;
  });
  return `${fakeBin}${path.delimiter}${dirs.join(path.delimiter)}`;
}

/* -------------------------------- test 1 ------------------------------ */

test(`the shipped opencode.jsonc round-trips through OpenCode ${HOST ? HOST.raw : '(absent)'} with nothing dropped`, { skip: SKIP }, () => {
  const distro = readDistroConfig();
  const { dir, info } = probeHost(distro);
  try {
    assert.deepEqual(dropped(distro, info), [], 'every key/value the package ships survives the host schema');
    // Shape pins on the blocks the harness's guarantees ride on.
    assert.ok(Array.isArray(info.permissions), 'permissions is an array in 2.2.0');
    assert.equal(info.permissions.length, distro.permissions.length, 'no permission rule was dropped');
    for (const rule of info.permissions) {
      assert.deepEqual(Object.keys(rule).sort(), ['action', 'effect', 'resource'], 'permission rule is {action, resource, effect}');
    }
    assert.ok(Array.isArray(info.policies), 'policies is an accepted 2.2.0 key');
    assert.equal(info.policies.length, 6, 'all 6 tool.use policies survive the action filter');
    for (const p of info.policies) assert.equal(p.action, 'tool.use', 'policy action tool.use is in the 2.2.0 enum');
    assert.equal(info.default_agent, 'orchestrator', 'default_agent (snake_case) is the 2.2.0 key');
    assert.ok(!('plugin' in info) && !('permission' in info), 'the host did not normalize a legacy singular key out of the shipped config');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the host drops a 1.x plugins tuple, and keeps every plain specifier', { skip: SKIP }, () => {
  // The regression this pins: a 1.x `[specifier, options]` entry is not merely
  // ignored by 2.2.0 — it is dropped, so the plugin never loads. Plain
  // specifiers in every 2.2.0 form (npm name, name@version, github:…, local
  // path) survive untouched.
  const { dir, info } = probeHost({
    plugins: [
      ['tuple-only'],
      ['with-opts', { opt: 1 }],
      42,
      'plain-name',
      'pinned@1.2.3',
      'github:owner/repo#abc123::path:plugins/opencode',
    ],
  });
  try {
    assert.deepEqual(info.plugins, [
      'plain-name',
      'pinned@1.2.3',
      'github:owner/repo#abc123::path:plugins/opencode',
    ], 'only plain specifier strings survive the 2.2.0 plugin schema');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a CLI-merged config with a 1.x tuple plugin is host-valid and keeps the plugin', { skip: SKIP, timeout: 300000 }, () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'oc-hostmerge-'));
  const cfg = path.join(base, 'cfg');
  mkdirSync(cfg, { recursive: true });
  const fakeBin = path.join(base, 'fakebin');
  mkdirSync(fakeBin, { recursive: true });
  writeFakeOpencode(fakeBin);

  // A 1.x-era adopter config: the retired distro plugin, a tuple-form plugin,
  // and a canonical string plugin. The merge must emit strings for all of them.
  // `model` is a real `provider/model` specifier: 2.2.0 keeps a string only in
  // that form (it normalizes to {providerID, model} and drops a bare word), so
  // the round-trip below grades the merge, not the fixture.
  writeFileSync(path.join(cfg, 'opencode.jsonc'), JSON.stringify({
    model: 'adopter/model-1',
    plugins: [['legacy-tuple', { opt: 1 }], 'adopter-plugin'],
  }, null, 2));

  const env = {
    OPENCODE_CONFIG_DIR: cfg,
    FAKE_OPENCODE_CONFIG: cfg,
    FAKE_OPENCODE_PLUGINS: 'legacy-tuple adopter-plugin',
    PATH: fakePath(fakeBin),
  };
  try {
    // Spread process.env: PATHEXT/SystemRoot/ComSpec must survive or PowerShell
  // cannot resolve the `opencode.cmd` shim and every CLI law drifts.
  const r = spawnSync(process.execPath, [CLI, 'setup'], {
    encoding: 'utf8', input: 'y\n', cwd: cfg, env: { ...process.env, ...env },
  });
    assert.equal(r.status, 0, `setup exit was ${r.status}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);

    const emitted = JSON.parse(stripJsonc(readFileSync(path.join(cfg, 'opencode.jsonc'), 'utf8')));
    assert.deepEqual(emitted.plugins, ['legacy-tuple', 'adopter-plugin'], 'the tuple is reduced to its specifier and deduped, order kept');
    assert.ok(!(r.stdout || '').includes('legacy-tuple System.'), 'the doctor never saw an unresolved tuple entry');

    const { dir, info } = probeHost(emitted);
    try {
      assert.deepEqual(dropped(emitted, info), [], 'the merged config the CLI wrote survives the 2.2.0 schema intact');
      assert.deepEqual(info.plugins, ['legacy-tuple', 'adopter-plugin'], 'both plugins load in 2.2.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
