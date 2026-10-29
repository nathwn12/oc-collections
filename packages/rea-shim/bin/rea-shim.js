#!/usr/bin/env node
'use strict';
//
// rea-shim launcher (unofficial, personal use).
//
// Published package model: this tarball holds only this launcher and its
// bootstrap support. It ships NO upstream code, NO `os` field and NO
// `scripts`/postinstall field. Upstream (`rea-agents`) is resolved at RUN time
// via npx, always at latest unless pinned with REA_SHIM_AGENTS_VERSION.
//
// `--bootstrap` is the only mutating command. It is explicit. It follows the
// exact upstream rea-agents release it installs: that release's Ghidra policy
// selects the Ghidra line, and the installed Ghidra's application.properties
// selects the JDK minimum. It installs unmodified official archives verified
// against official release data, then runs the real upstream doctor, MCP tool
// inventory and a Ghidra headless analysis. `--doctor` stays read-only.
//
// Run path (mirrors the house pump scripts/mcp-rea.ps1 child exec + env
// contract):
//   - child:  npx -y rea-agents@<latest|pin> --mcp   (top-level `--mcp`
//             flag = "Start as MCP stdio server"; bare `rea mcp` does not
//             serve)
//   - spawned as cmd.exe /d /c <npx ...> with stdio inherited, so the child
//     IS the MCP channel; ALL launcher chatter goes to stderr, stdout belongs
//     to the JSON-RPC frames. No stdout writes exist on the run path.
//   - env injected verbatim: GHIDRA_INSTALL_DIR, JAVA_HOME (+ <jdk>\bin
//     prepended to PATH), REA_GHIDRA_STARTUP_TIMEOUT_MS=1500000.
//   - the child exit code is forwarded; the shared console lets Ctrl+C reach
//     the whole tree.
//
// Builtins only; no dependencies.
//

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const discovery = require('../lib/discovery.js');
const { runBootstrap } = require('../lib/bootstrap.js');
const PKG = require('../package.json');

const SHIM_NAME = 'rea-shim';
const {
  AGENTS_VERSION_ENV,
  GHIDRA_OVERRIDE_ENV,
  JDK_ENV,
  STARTUP_TIMEOUT_ENV,
  STARTUP_TIMEOUT_MS,
  bootstrapRoot,
  ghidraJavaRequirement,
  javaRequirementLabel,
  resolveGhidra,
  resolveJdk,
} = discovery;

function fail(message) {
  fs.writeSync(2, `${SHIM_NAME}: error: ${message}\n`);
  process.exit(1);
}

function refuse(message) {
  // Missing-dependency refusal: non-zero with exact fix steps.
  fs.writeSync(2, `${SHIM_NAME}: refusing: ${message}\n`);
  process.exit(2);
}

function log(message) {
  fs.writeSync(2, `${SHIM_NAME}: ${message}\n`);
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
  try {
    const output = execFileSync('cmd.exe', ['/d', '/c', 'npm', 'view', 'rea-agents', 'version'], {
      timeout: 30000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const version = String(output || '').trim();
    return version || 'unknown';
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
    GHIDRA_INSTALL_DIR: ghidraDir,
    JAVA_HOME: jdkHome,
    PATH: `${path.join(jdkHome, 'bin')};${process.env.PATH || ''}`,
    [STARTUP_TIMEOUT_ENV]: STARTUP_TIMEOUT_MS,
  };
}

function runServer(jdk, ghidra, agents) {
  const args = childArgv(agents.spec);
  log(`starting upstream: cmd.exe ${args.join(' ')}`);
  log(`env: GHIDRA_INSTALL_DIR=${ghidra.dir} JAVA_HOME=${jdk.home} ${STARTUP_TIMEOUT_ENV}=${STARTUP_TIMEOUT_MS}`);
  const child = spawn('cmd.exe', args, { stdio: 'inherit', env: childEnv(jdk.home, ghidra.dir) });
  child.on('error', (error) => fail(`cannot start child: ${error.message}`));
  child.on('exit', (code, signal) => {
    if (signal) {
      log(`child terminated by signal ${signal}`);
      process.exit(1);
    }
    process.exit(code === null ? 1 : code);
  });
}

function printDoctor() {
  const ghidra = resolveGhidra();
  const agents = resolveAgentsVersion();
  const upstream = agents.version === 'latest' ? upstreamVersion() : agents.version;
  const out = [];
  out.push(`${SHIM_NAME} doctor`);
  out.push(`node: ${process.version}`);
  if (ghidra) out.push(`ghidra: ${ghidra.dir} (source ${ghidra.source})`);
  else out.push('ghidra: MISSING');

  let requirement = null;
  let requirementError = null;
  if (ghidra) {
    try {
      requirement = ghidraJavaRequirement(ghidra.dir);
      out.push(`java requirement: ${javaRequirementLabel(requirement)} (from ${requirement.propertiesFile})`);
    } catch (error) {
      requirementError = error.message;
      out.push(`java requirement: UNREADABLE (${error.message})`);
    }
  } else {
    out.push('java requirement: not checked (no Ghidra installation)');
  }

  let jdk = null;
  let jdkError = null;
  if (requirement) {
    try {
      jdk = resolveJdk(requirement);
    } catch (error) {
      jdkError = error.message;
      out.push(`jdk: INVALID (${error.message})`);
    }
  }
  if (jdk) out.push(`jdk: ${jdk.home} (major ${jdk.major}, source ${jdk.source})`);
  else if (requirement) out.push(`jdk: MISSING (need ${javaRequirementLabel(requirement)})`);
  else out.push('jdk: not checked');

  out.push(`upstream: rea-agents@${upstream} (${agents.source})`);
  out.push(`child: cmd.exe ${childArgv(agents.spec).join(' ')}`);
  fs.writeSync(1, out.join('\n') + '\n');

  if (!ghidra) {
    refuse(
      'no Ghidra dir found (env override -> rea-shim bootstrap -> scoop apps/ghidra/current). ' +
      `Fix: set ${GHIDRA_OVERRIDE_ENV} to the extracted Ghidra install dir, or run '${SHIM_NAME} --bootstrap'.`,
    );
  }
  if (!requirement) {
    refuse(
      `${requirementError || 'cannot read the JDK requirement from the selected Ghidra'}. ` +
      `Fix: point ${GHIDRA_OVERRIDE_ENV} at an extracted official Ghidra release, or run '${SHIM_NAME} --bootstrap'.`,
    );
  }
  if (!jdk) {
    refuse(
      `${jdkError || `no JDK satisfying the installed Ghidra's declared ${javaRequirementLabel(requirement)} requirement was found`} ` +
      `(env override -> rea-shim bootstrap -> scoop -> Eclipse Adoptium). ` +
      `Fix: set ${JDK_ENV} to a full JDK home, or run '${SHIM_NAME} --bootstrap'.`,
    );
  }
  process.exit(0);
}

function parseBootstrapArgs(args) {
  let dryRun = false;
  let sawBootstrap = false;
  let sawDryRun = false;
  for (const arg of args) {
    if (arg === '--bootstrap') {
      if (sawBootstrap) usage(2, process.stderr);
      sawBootstrap = true;
      continue;
    }
    if (arg === '--dry-run') {
      if (sawDryRun) usage(2, process.stderr);
      sawDryRun = true;
      dryRun = true;
      continue;
    }
    usage(2, process.stderr);
  }
  if (!sawBootstrap) usage(2, process.stderr);
  return { dryRun };
}

function usage(exitCode, stream) {
  const text = [
    `usage: ${SHIM_NAME} [--bootstrap [--dry-run] | --doctor | --version | --print-config | --help]`,
    '',
    `  (no args)      resolve the Ghidra-declared JDK requirement and Ghidra, then serve`,
    `                   upstream MCP over stdio: cmd.exe /d /c npx -y rea-agents@<latest|pin> --mcp`,
    '  --bootstrap    install the exact upstream rea-agents release, the latest',
    '                 official NSA Ghidra release in the line that release',
    '                 accepts, and the latest official Temurin JDK at the',
    '                 Java minimum declared by that Ghidra. Every archive is',
    '                 verified against official release data; existing installs',
    '                 are reused only with a matching marker and never',
    '                 overwritten. Then runs the upstream doctor, MCP tool',
    '                 inventory and a real Ghidra headless analysis. Windows',
    '                 x64 only; the shim writes its install under the root.',
    '  --dry-run      with --bootstrap: print the plan and write nothing.',
    '  --doctor       print node, the resolved Ghidra dir, the Java requirement',
    '                 declared by that Ghidra, the resolved JDK, the upstream',
    '                 version and the exact child command; exit 0. Read-only:',
    '                 it never installs and never creates the bootstrap root.',
    '  --version      print the shim version',
    '  --print-config print the opencode.jsonc block for this machine',
    '  --help, -h     print this usage',
    '',
    'overrides (env):',
    `  ${JDK_ENV}        pin the JDK home (must satisfy the Ghidra-declared bounds)`,
    `  ${GHIDRA_OVERRIDE_ENV}   pin the Ghidra install dir`,
    `  ${AGENTS_VERSION_ENV} pin rea-agents@<v> instead of @latest (bootstrap: exact only)`,
    '  REA_SHIM_HOME    bootstrap install root (default %LOCALAPPDATA%\\rea-shim)',
    'discovery: env override -> rea-shim bootstrap -> scoop',
    '  (apps/ghidra/current, scoop JDKs) -> C:\\Program Files\\Eclipse Adoptium',
    '  (jdk-*). The JDK floor is read from the selected Ghidra, never a constant.',
  ].join('\n') + '\n';
  fs.writeSync(stream === process.stderr ? 2 : 1, text);
  process.exit(exitCode);
}

function printVersion() {
  fs.writeSync(1, `${PKG.version}\n`);
  process.exit(0);
}

function printConfig() {
  // Emitted in the shape the installed client writes itself: OpenCode 2.2
  // (verified through 2.2.1) `mcp add` produces
  // { mcp: { servers: { <name>: { type, command } } } }.
  // A flat `mcp.<name>` entry (the pre-2.2 layout this used to print) is not
  // what 2.2 reads, and an unverified `timeout` key is not a knob the client
  // honours, so neither is printed.
  const block = {
    mcp: {
      servers: {
        rea: { type: 'local', command: ['cmd', '/c', 'npx', '-y', `${SHIM_NAME}@latest`] },
      },
    },
  };
  fs.writeSync(1, JSON.stringify(block, null, 2) + '\n');
  process.exit(0);
}

function reportBootstrapFailure(error) {
  const message = error && error.message ? error.message : String(error);
  fs.writeSync(2, `${SHIM_NAME}: bootstrap FAILED: ${message}\n`);
  if (process.env.REA_SHIM_DEBUG === '1' && error && error.stack) {
    fs.writeSync(2, `${error.stack}\n`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--bootstrap')) {
    if (args.includes('--help') || args.includes('-h')) usage(0, process.stdout);
    if (args.includes('--doctor') || args.includes('--version') || args.includes('--print-config')) {
      usage(2, process.stderr);
    }
    let parsed;
    try {
      parsed = parseBootstrapArgs(args);
    } catch (error) {
      reportBootstrapFailure(error);
      process.exit(1);
    }
    runBootstrap({ dryRun: parsed.dryRun }).then(() => {
      process.exit(0);
    }).catch((error) => {
      reportBootstrapFailure(error);
      process.exit(1);
    });
    return;
  }
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
  if (args.length > 0) usage(2, process.stderr);

  const ghidra = resolveGhidra();
  if (!ghidra) {
    refuse(
      'no Ghidra dir found (env override -> rea-shim bootstrap -> scoop apps/ghidra/current). ' +
      `Fix: set ${GHIDRA_OVERRIDE_ENV} to the Ghidra install dir, or run '${SHIM_NAME} --bootstrap'.`,
    );
  }
  let requirement;
  try {
    requirement = ghidraJavaRequirement(ghidra.dir);
  } catch (error) {
    refuse(`${error.message}. Fix: point ${GHIDRA_OVERRIDE_ENV} at an extracted official Ghidra release, or run '${SHIM_NAME} --bootstrap'.`);
  }
  let jdk;
  try {
    jdk = resolveJdk(requirement);
  } catch (error) {
    refuse(`${error.message}. Fix: set ${JDK_ENV}, or run '${SHIM_NAME} --bootstrap'.`);
  }
  if (!jdk) {
    refuse(
      `no JDK satisfying the installed Ghidra's declared ${javaRequirementLabel(requirement)} requirement was found ` +
      `(env override -> rea-shim bootstrap -> scoop -> Eclipse Adoptium). ` +
      `Fix: set ${JDK_ENV} to a full JDK home, or run '${SHIM_NAME} --bootstrap'.`,
    );
  }
  runServer(jdk, ghidra, resolveAgentsVersion());
}

if (require.main === module) main();

module.exports = {
  bootstrapRoot,
  main,
  parseBootstrapArgs,
  resolveGhidra,
  resolveJdk,
};
