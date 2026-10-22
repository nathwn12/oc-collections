#!/usr/bin/env node
'use strict';
//
// rea-shim launcher (unofficial, personal use).
//
// Published package model: this tarball holds ONLY this launcher. It holds
// NO upstream code, NO `os` field, NO `scripts`/postinstall field. Upstream
// (`rea-agents`) is resolved at RUN time via npx, always at latest unless
// pinned with REA_SHIM_AGENTS_VERSION.
//
// Run path (mirrors the house pump scripts/mcp-rea.ps1 child exec + env
// contract exactly):
//   - child:  npx -y rea-agents@<latest|pin> --mcp   (top-level `--mcp`
//             flag = "Start as MCP stdio server" per upstream `--help`;
//             bare `rea mcp` takes only `add`/`doctor` subcommands and
//             does NOT serve)
//   - spawned as cmd.exe /d /c <npx ...> with stdio inherited, so the child
//     IS the MCP channel; ALL launcher chatter goes to stderr, stdout
//     belongs to the JSON-RPC frames. No stdout writes exist on the run path.
//   - env injected verbatim: GHIDRA_INSTALL_DIR, JAVA_HOME (+ <jdk>\bin
//     prepended to PATH), REA_GHIDRA_STARTUP_TIMEOUT_MS=1500000.
//   - Windows process handling mirrors puppet-mcp: shared console, so Ctrl+C
//     reaches the whole tree; the child exit code is forwarded.
//   - the pump's REA checkout (WorkingDirectory = ReaDir) has no equivalent
//     here: npx resolves the upstream package into the npm cache, so cwd is
//     inherited unchanged.
//
// Builtins only: node:fs, node:path, node:os, node:child_process.
// No dependencies, so the published tarball stays tiny and auditable.
//

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const PKG = require('../package.json');
const SHIM_NAME = 'rea-shim';

// Env contract names, verbatim from the house pump (scripts/mcp-rea.ps1).
const GHIDRA_ENV = 'GHIDRA_INSTALL_DIR';
const JDK_ENV = 'REA_SHIM_JDK_HOME';
const GHIDRA_OVERRIDE_ENV = 'REA_SHIM_GHIDRA_DIR';
const AGENTS_VERSION_ENV = 'REA_SHIM_AGENTS_VERSION';
const STARTUP_TIMEOUT_ENV = 'REA_GHIDRA_STARTUP_TIMEOUT_MS';
const STARTUP_TIMEOUT_MS = '1500000';
// Legacy pump names (read, never invented): honoured as fallbacks below the
// rea-shim overrides.
const LEGACY_GHIDRA_ENVS = ['REA_GHIDRA_DIR', 'GHIDRA_INSTALL_DIR'];
const LEGACY_JDK_ENVS = ['REA_JDK_HOME', 'JAVA_HOME'];
const MIN_JAVA_MAJOR = 21;

function fail(message) {
  process.stderr.write(`${SHIM_NAME}: error: ${message}\n`);
  process.exit(1);
}

function refuse(message) {
  // Missing-dependency refusal: non-zero with exact fix steps (mirrors the
  // pump's exit-2 boundary for a missing dep).
  process.stderr.write(`${SHIM_NAME}: refusing: ${message}\n`);
  process.exit(2);
}

function log(message) {
  process.stderr.write(`${SHIM_NAME}: ${message}\n`);
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function javaExe(home) {
  return path.join(home, 'bin', 'java.exe');
}

function javaMajor(home) {
  // Returns the java major version, or null when unresolvable.
  // `java -version` exits 0 and writes to stderr, so capture both streams
  // with spawnSync (which never throws on exit code) and parse the merged
  // text: `openjdk version "21.0.12.1"` or legacy `java version "1.8.0_..."`.
  let text = '';
  try {
    const r = spawnSync(javaExe(home), ['-version'], { timeout: 15000, encoding: 'utf8' });
    text = String((r && r.stdout) || '') + String((r && r.stderr) || '');
    if (r && r.error) return null;
  } catch {
    return null;
  }
  const m = text.match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  if (m[1] === '1' && m[2]) return Number(m[2]);
  return Number(m[1]);
}

function scoopRoot() {
  return process.env.SCOOP || path.join(os.homedir(), 'scoop');
}

function scoopAppCurrent(app) {
  return path.join(scoopRoot(), 'apps', app, 'current');
}

function resolveGhidra() {
  // Discovery: REA_SHIM_GHIDRA_DIR -> REA_GHIDRA_DIR -> GHIDRA_INSTALL_DIR
  // -> scoop apps\ghidra\current.
  const candidates = [];
  if (process.env[GHIDRA_OVERRIDE_ENV]) {
    candidates.push({ dir: process.env[GHIDRA_OVERRIDE_ENV], source: GHIDRA_OVERRIDE_ENV });
  }
  for (const name of LEGACY_GHIDRA_ENVS) {
    if (process.env[name]) candidates.push({ dir: process.env[name], source: name });
  }
  candidates.push({ dir: scoopAppCurrent('ghidra'), source: 'scoop apps/ghidra/current' });
  for (const c of candidates) {
    if (c.dir && dirExists(c.dir)) return c;
  }
  return null;
}

function collectJdkCandidates() {
  // Discovery: REA_SHIM_JDK_HOME -> REA_JDK_HOME -> JAVA_HOME (each only
  // honoured at major >= 21; a < 21 JAVA_HOME is never trusted) -> scoop
  // JDK app currents -> C:\Program Files\Eclipse Adoptium\jdk-*.
  const homes = [];
  if (process.env[JDK_ENV]) {
    homes.push({ home: process.env[JDK_ENV], source: JDK_ENV, override: true });
  }
  for (const name of LEGACY_JDK_ENVS) {
    if (process.env[name]) homes.push({ home: process.env[name], source: name, override: false });
  }
  // Scoop: any app whose current holds bin\java.exe.
  try {
    const appsDir = path.join(scoopRoot(), 'apps');
    for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const current = path.join(appsDir, entry.name, 'current');
      if (dirExists(current) && fs.existsSync(javaExe(current))) {
        homes.push({ home: current, source: `scoop ${entry.name}`, override: false });
      }
    }
  } catch {
    // No scoop tree: not an error, just no candidates from it.
  }
  // Adoptium: jdk-* dirs (JDKs only, never jre-*).
  try {
    const adoptium = 'C:\\Program Files\\Eclipse Adoptium';
    for (const entry of fs.readdirSync(adoptium, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^jdk-/i.test(entry.name)) continue;
      const home = path.join(adoptium, entry.name);
      if (fs.existsSync(javaExe(home))) {
        homes.push({ home, source: 'Eclipse Adoptium', override: false });
      }
    }
  } catch {
    // Absent Adoptium root: not an error.
  }
  return homes;
}

function versionTuple(home) {
  const m = String(home).match(/jdk-(\d+(?:[._]\d+)*)/i);
  if (!m) return [];
  return m[1].split(/[._]/).map(Number);
}

function compareHomes(a, b) {
  if (a.major !== b.major) return b.major - a.major;
  const ta = versionTuple(a.home);
  const tb = versionTuple(b.home);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const d = (tb[i] || 0) - (ta[i] || 0);
    if (d !== 0) return d;
  }
  return a.home < b.home ? -1 : 1;
}

function resolveJdk() {
  const candidates = collectJdkCandidates();
  const seen = new Set();
  const viable = [];
  for (const c of candidates) {
    if (!c.home || seen.has(c.home.toLowerCase())) continue;
    seen.add(c.home.toLowerCase());
    if (!fs.existsSync(javaExe(c.home))) {
      if (c.override) {
        refuse(
          `${JDK_ENV}='${c.home}' has no bin\\java.exe. ` +
          `Fix: set ${JDK_ENV} to a JDK 21+ home (e.g. C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot), ` +
          `or unset it to use auto-discovery.`
        );
      }
      continue;
    }
    const major = javaMajor(c.home);
    if (major === null) {
      if (c.override) {
        refuse(
          `${JDK_ENV}='${c.home}' exists but 'bin\\java.exe -version' gave no parseable version. ` +
          `Fix: point ${JDK_ENV} at a working JDK 21+ home.`
        );
      }
      continue;
    }
    if (major < MIN_JAVA_MAJOR) {
      if (c.override) {
        refuse(
          `${JDK_ENV}='${c.home}' is java major ${major}; rea needs >= ${MIN_JAVA_MAJOR}. ` +
          `Fix: set ${JDK_ENV} to a JDK 21+ home (e.g. C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot).`
        );
      }
      // Never trust a < 21 JAVA_HOME (or any legacy/scoop/Adoptium < 21): skip.
      continue;
    }
    if (c.override) return { home: c.home, major, source: c.source };
    viable.push({ home: c.home, major, source: c.source });
  }
  if (viable.length === 0) return null;
  viable.sort(compareHomes);
  return viable[0];
}

function resolveAgentsVersion() {
  const pin = process.env[AGENTS_VERSION_ENV];
  if (!pin) return { spec: 'rea-agents@latest', version: 'latest', source: 'dist-tag latest' };
  if (!/^[A-Za-z0-9._-]+$/.test(pin)) {
    fail(`${AGENTS_VERSION_ENV}='${pin}' is not a plain version/tag; refusing to interpolate it into the child command.`);
  }
  return { spec: `rea-agents@${pin}`, version: pin, source: `${AGENTS_VERSION_ENV}=${pin}` };
}

function upstreamVersion() {
  // Resolved upstream version (dist-tag): `npm view` over cmd so npm.cmd
  // resolves on Windows without a shell dependency in the caller.
  try {
    const out = execFileSync('cmd.exe', ['/d', '/c', 'npm', 'view', 'rea-agents', 'version'], {
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const v = String(out).trim();
    return v || 'unknown';
  } catch {
    return 'unknown';
  }
}

function childArgv(agentsSpec) {
  return ['/d', '/c', 'npx', '-y', agentsSpec, '--mcp'];
}

function childEnv(jdkHome, ghidraDir) {
  return {
    ...process.env,
    [GHIDRA_ENV]: ghidraDir,
    JAVA_HOME: jdkHome,
    PATH: `${path.join(jdkHome, 'bin')};${process.env.PATH || ''}`,
    [STARTUP_TIMEOUT_ENV]: STARTUP_TIMEOUT_MS,
  };
}

function runServer(jdk, ghidra, agents) {
  const args = childArgv(agents.spec);
  log(`starting upstream: cmd.exe ${args.join(' ')}`);
  log(`env: ${GHIDRA_ENV}=${ghidra.dir} JAVA_HOME=${jdk.home} ${STARTUP_TIMEOUT_ENV}=${STARTUP_TIMEOUT_MS}`);
  // Shared console (same as puppet-mcp): Ctrl+C reaches the whole tree, so
  // no signal relay is needed; the child exit code is forwarded below and no
  // orphaned process tree is left behind on a clean exit.
  const child = spawn('cmd.exe', args, { stdio: 'inherit', env: childEnv(jdk.home, ghidra.dir) });
  child.on('error', (err) => fail(`cannot start child: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (signal) {
      log(`child terminated by signal ${signal}`);
      process.exit(1);
    }
    process.exit(code === null ? 1 : code);
  });
}

function printDoctor() {
  const jdk = resolveJdk();
  const ghidra = resolveGhidra();
  const agents = resolveAgentsVersion();
  const up = upstreamVersion();
  const out = [];
  out.push(`${SHIM_NAME} doctor`);
  out.push(`node: ${process.version}`);
  if (jdk) out.push(`jdk: ${jdk.home} (major ${jdk.major}, source ${jdk.source})`);
  else out.push(`jdk: MISSING (need java major >= ${MIN_JAVA_MAJOR})`);
  if (ghidra) out.push(`ghidra: ${ghidra.dir} (source ${ghidra.source})`);
  else out.push(`ghidra: MISSING`);
  out.push(`upstream: rea-agents@${up} (${agents.source})`);
  out.push(`child: cmd.exe ${childArgv(agents.spec).join(' ')}`);
  process.stdout.write(out.join('\n') + '\n');
  if (!jdk) {
    refuse(
      `no JDK >= ${MIN_JAVA_MAJOR} found (env override -> scoop -> Eclipse Adoptium). ` +
      `Fix: install Temurin 21+ and set ${JDK_ENV} to its home, e.g. ` +
      `C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.12.101-hotspot. ` +
      `Note: a JAVA_HOME pointing at JDK < 21 is ignored on purpose.`
    );
  }
  if (!ghidra) {
    refuse(
      `no Ghidra dir found (env override -> scoop apps/ghidra/current). ` +
      `Fix: install Ghidra (scoop: 'scoop install ghidra') or set ${GHIDRA_OVERRIDE_ENV} to its install dir.`
    );
  }
  process.exit(0);
}

function usage(exitCode, stream) {
  const text = [
    `usage: ${SHIM_NAME} [--doctor | --version | --print-config | --help]`,
    '',
    `  (no args)      resolve JDK 21+ and Ghidra, then serve upstream MCP over stdio:`,
    `                   cmd.exe /d /c npx -y rea-agents@<latest|pin> --mcp`,
    '  --doctor       print node, resolved JDK + java major, Ghidra dir,',
    '                 upstream version, and the exact child command; exit 0.',
    '                 Refuses (non-zero) when java major < 21 or Ghidra is missing.',
    '  --version      print the shim version',
    '  --print-config print the opencode.jsonc block for this machine',
    '  --help, -h     print this usage',
    '',
    'overrides (env):',
    `  ${JDK_ENV}        pin the JDK home (must be java >= 21)`,
    `  ${GHIDRA_OVERRIDE_ENV}   pin the Ghidra install dir`,
    `  ${AGENTS_VERSION_ENV} pin rea-agents@<v> instead of @latest`,
    `discovery: env override -> scoop (apps/ghidra/current, scoop JDKs)`,
    `  -> C:\\Program Files\\Eclipse Adoptium\\jdk-* -> highest java >= 21.`,
    '  A JAVA_HOME below 21 is never trusted.',
  ].join('\n') + '\n';
  stream.write(text);
  process.exit(exitCode);
}

function printVersion() {
  process.stdout.write(`${PKG.version}\n`);
  process.exit(0);
}

function printConfig() {
  // Exact opencode.jsonc block for this machine.
  const block = [
    '"rea": { "type": "local", "timeout": { "startup": 45000 }, "command": ["cmd","/c","npx","-y","rea-shim@latest"] }',
  ].join('\n') + '\n';
  process.stdout.write(block);
  process.exit(0);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) usage(0, process.stdout);
  if (args.includes('--version')) {
    if (args.length !== 1) usage(2, process.stderr);
    printVersion();
  }
  if (args.includes('--print-config')) {
    if (args.length !== 1) usage(2, process.stderr);
    printConfig();
  }
  if (args.includes('--doctor')) {
    if (args.length !== 1) usage(2, process.stderr);
    printDoctor(); // exits
  }
  // Every known flag returns above; anything left is unknown.
  if (args.length > 0) usage(2, process.stderr);

  const jdk = resolveJdk();
  if (!jdk) {
    refuse(
      `no JDK >= ${MIN_JAVA_MAJOR} found (env override -> scoop -> Eclipse Adoptium). ` +
      `Fix: install Temurin 21+ and set ${JDK_ENV} to its home, or run '${SHIM_NAME} --doctor'. ` +
      `Note: a JAVA_HOME pointing at JDK < 21 is ignored on purpose.`
    );
  }
  const ghidra = resolveGhidra();
  if (!ghidra) {
    refuse(
      `no Ghidra dir found (env override -> scoop apps/ghidra/current). ` +
      `Fix: set ${GHIDRA_OVERRIDE_ENV} to its install dir, or run '${SHIM_NAME} --doctor'.`
    );
  }
  runServer(jdk, ghidra, resolveAgentsVersion());
}

main();
