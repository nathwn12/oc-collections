'use strict';
//
// The explicit `rea-shim --bootstrap` orchestration.
//
// It follows upstream, never a shim pin:
//   1. resolve one exact rea-agents release and install it unmodified;
//   2. read that release's Ghidra release policy;
//   3. pick the latest official NSA Ghidra release in the accepted line and
//      verify its SHA-256 from official release data;
//   4. read the installed Ghidra's declared Java minimum;
//   5. install the latest official Temurin JDK for that minimum, with the
//      checksum published by the Adoptium API;
//   6. run the exact installed rea-agents against that pair.
//
// Any missing policy, official artifact or published hash stops the run. There
// is no fallback to an older shim pin and no opt-in unsupported Ghidra line.
//

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const discovery = require('./discovery.js');
const install = require('./install.js');
const sources = require('./sources.js');
const checks = require('./checks.js');
const {
  ensurePlainDir,
  fail,
  isPlainFile,
  logLine,
} = require('./support.js');

function parseJavaMajor(text) {
  const match = String(text || '').match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  if (match[1] === '1' && match[2]) return Number(match[2]);
  return Number(match[1]);
}

function parseJavaVersionString(text) {
  const match = String(text || '').match(/version "([^"]+)"/);
  return match ? match[1] : null;
}

function parseJavaHome(text) {
  const match = String(text || '').match(/^\s*java\.home\s*=\s*(.+)$/m);
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, '');
}

function probeJava(home) {
  const java = path.join(home, 'bin', 'java.exe');
  const result = spawnSync(java, ['-XshowSettings:properties', '-version'], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) fail(`cannot run ${java}: ${result.error.message}`);
  return {
    status: result.status,
    text: String(result.stdout || '') + String(result.stderr || ''),
  };
}

/**
 * Verify the installed Ghidra is exactly the release the official data named,
 * that upstream's policy accepts it, and that it declares usable Java bounds.
 */
function verifyGhidra(dir, expected, policy) {
  if (!isPlainFile(path.join(dir, 'Ghidra', 'application.properties'))) {
    fail(`Ghidra check failed: ${path.join(dir, 'Ghidra', 'application.properties')} is missing`);
  }
  let requirement;
  try {
    requirement = discovery.ghidraJavaRequirement(dir);
  } catch (error) {
    fail(`Ghidra check failed: ${error.message}`);
  }
  if (requirement.version !== expected.version) {
    fail(`Ghidra check failed: application.properties reports ${requirement.version || 'no version'}, expected ${expected.version}`);
  }
  const properties = discovery.readProperties(requirement.propertiesFile);
  const build = properties.get('application.build.date.short');
  if (expected.build && build && build !== expected.build) {
    fail(`Ghidra check failed: application.properties reports build ${build}, expected ${expected.build}`);
  }
  if (!policy.accepts(requirement.version)) {
    fail(
      `Ghidra check failed: upstream rea-agents policy accepts ${policy.line} ` +
      `(verified ${policy.supportedVersion}), not ${requirement.version}`,
    );
  }
  if (!isPlainFile(path.join(dir, 'support', 'analyzeHeadless.bat'))) {
    fail(`Ghidra check failed: ${path.join(dir, 'support', 'analyzeHeadless.bat')} is missing`);
  }
  if (!isPlainFile(path.join(dir, 'Ghidra', 'Features', 'Decompiler', 'os', 'win_x86_64', 'decompile.exe'))) {
    fail('Ghidra check failed: the Windows x64 decompiler binary is missing');
  }
  return {
    version: requirement.version,
    javaMin: requirement.minimum,
    javaMax: requirement.maximum,
    propertiesFile: requirement.propertiesFile,
  };
}

function verifyJdk(home, requirement) {
  const java = path.join(home, 'bin', 'java.exe');
  const javac = path.join(home, 'bin', 'javac.exe');
  if (!isPlainFile(java)) fail(`JDK check failed: ${java} is missing or is not a plain file`);
  if (!isPlainFile(javac)) fail(`JDK check failed: ${javac} is missing; a full JDK is required, not a JRE`);
  const probe = probeJava(home);
  if (probe.status !== 0) fail(`JDK check failed: '${java} -version' exited ${probe.status}`);
  const major = parseJavaMajor(probe.text);
  if (major === null) fail(`JDK check failed: cannot parse a Java version from '${java} -version'`);
  if (!discovery.satisfies(requirement, major)) {
    fail(
      `JDK check failed: java major ${major} is outside the installed Ghidra's declared ` +
      `${discovery.javaRequirementLabel(requirement)} requirement`,
    );
  }
  if (!/sun\.arch\.data\.model\s*=\s*64\b/.test(probe.text)) {
    fail(`JDK check failed: ${java} is not a 64-bit JDK`);
  }
  const reportedHome = parseJavaHome(probe.text);
  if (reportedHome) {
    const normalize = (value) => {
      try {
        return fs.realpathSync.native(value);
      } catch {
        return path.resolve(value);
      }
    };
    if (normalize(reportedHome).toLowerCase() !== normalize(home).toLowerCase()) {
      fail(`JDK check failed: java.home is ${reportedHome}, expected ${home}`);
    }
  }
  let releaseVersion = null;
  try {
    const release = fs.readFileSync(path.join(home, 'release'), 'utf8');
    const match = release.match(/^JAVA_VERSION="([^"]+)"/m);
    if (match) releaseVersion = match[1];
  } catch {
    // The release file is a cross-check, not the only proof.
  }
  if (releaseVersion && !releaseVersion.startsWith(`${major}.`) && releaseVersion !== String(major)) {
    fail(`JDK check failed: the release file reports ${releaseVersion}, expected major ${major}`);
  }
  return { major, version: releaseVersion || parseJavaVersionString(probe.text) || String(major) };
}

function bootstrapPlanLog(log, { root, upstream, dryRun }) {
  log('plan');
  log(`  install root: ${root}`);
  log(`  upstream: rea-agents@${upstream.version} (${upstream.source}${upstream.integrity ? `; integrity ${upstream.integrity}` : ''})`);
  log('  policy: read from the installed upstream release (dist/ghidra/GhidraReleasePolicy.js); no shim version table');
  log('  ghidra: latest official NSA Ghidra release in the upstream-accepted line; SHA-256 from official GitHub release data');
  log('  jdk: latest official Eclipse Temurin x64 Windows JDK at the application.java.min declared by that Ghidra');
  log('  checks: rea doctor --provider ghidra; rea mcp doctor; rea analyze (6502 fixture) --provider ghidra');
  if (dryRun) {
    log('  writes: nothing to the install root; the version lookup may use npm\'s own metadata cache');
  } else {
    log('  writes: shim install and npm cache under the install root; upstream checks may use their own temporary files');
    log('         no host JDK/Ghidra, JAVA_HOME or PATH changes');
  }
  log('  no fallback: an unsupported Ghidra line, a missing policy, or missing official data/hash stops the run');
}

async function runBootstrap(options = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    fail(`--bootstrap supports Windows x64 only (this host is ${process.platform}/${process.arch})`);
  }
  const env = options.env || process.env;
  const log = options.log || logLine;
  const root = discovery.bootstrapRoot(env);
  if (!options.dryRun) ensurePlainDir(root, 'install root');
  if (!options.dryRun) install.ensureNpmCache(root);
  const upstream = sources.resolveUpstreamRelease({
    env,
    integrity: !options.dryRun,
    runNpm: options.runNpm || ((args) => {
      // `npm view` writes to the same cache, so every metadata invocation gets
      // the same descendant walk immediately before npm runs, and the child
      // environment is rebuilt around that exact validated path. A dry run
      // passes no cache: npm keeps its own configured one, and an inherited
      // NPM_CONFIG_CACHE cannot redirect it.
      const npmCache = options.dryRun ? null : install.ensureNpmCache(root);
      return sources.defaultRunNpm(args, { env, npmCache });
    }),
  });

  bootstrapPlanLog(log, { root, upstream, dryRun: options.dryRun });
  if (options.dryRun) {
    fs.writeSync(1, `rea-shim: bootstrap dry run; nothing written to ${root}\n`);
    return { dryRun: true, root, upstream };
  }

  const upstreamInstall = await install.ensureUpstreamPackage({
    version: upstream.version,
    root,
    env,
    integrity: upstream.integrity,
    log,
  });
  const policy = await sources.readUpstreamPolicy(upstreamInstall.dir);
  log(`policy: rea-agents@${upstream.version} accepts Ghidra ${policy.line} (verified ${policy.supportedVersion})`);

  const ghidraRelease = await sources.resolveGhidraRelease({
    supportedVersion: policy.supportedVersion,
  });
  log(
    `official Ghidra ${ghidraRelease.version} build ${ghidraRelease.build}: ` +
    `${ghidraRelease.fileName} sha256 ${ghidraRelease.sha256} (${ghidraRelease.hashSource})`,
  );
  const ghidraInstall = await install.ensureArtifact({
    ...ghidraRelease,
    dirName: `ghidra-${ghidraRelease.version}-${ghidraRelease.build}`,
    expectedRootPattern: /^ghidra_/,
  }, { root, log });
  const ghidraCheck = verifyGhidra(ghidraInstall.dir, ghidraRelease, policy);
  log(`ghidra check: PASS (${ghidraCheck.version}; requires Java ${ghidraCheck.javaMin}${ghidraCheck.javaMax === null ? '+' : `..${ghidraCheck.javaMax}`})`);

  const requirement = discovery.ghidraJavaRequirement(ghidraInstall.dir);
  const jdkRelease = await sources.resolveJdkRelease({ requirement });
  log(
    `official JDK ${jdkRelease.version}: ${jdkRelease.fileName} sha256 ${jdkRelease.sha256} ` +
    `(${jdkRelease.hashSource})`,
  );
  const jdkInstall = await install.ensureArtifact({
    ...jdkRelease,
    expectedRootPattern: /^jdk-/,
  }, { root, log });
  const jdkCheck = verifyJdk(jdkInstall.dir, requirement);
  log(`jdk check: PASS (java ${jdkCheck.version}, major ${jdkCheck.major}, 64-bit full JDK)`);

  const upstreamChecks = await checks.runUpstreamChecks({
    agentsVersion: upstream.version,
    script: upstreamInstall.script,
    env: checks.childEnv(jdkInstall.dir, ghidraInstall.dir, env),
    tempDir: path.join(root, 'tmp'),
    ghidra: ghidraRelease,
    log,
  });

  const summary = [
    'rea-shim: bootstrap PASS',
    `  upstream: rea-agents@${upstream.version} (${upstream.source}${upstream.integrity ? `; integrity ${upstream.integrity}` : ''})`,
    `  policy: Ghidra ${policy.line} accepted (verified ${policy.supportedVersion})`,
    `  ghidra: ${ghidraInstall.dir} (Ghidra ${ghidraCheck.version} build ${ghidraRelease.build}; sha256 ${ghidraInstall.sha256} from ${ghidraInstall.hashSource})`,
    `  jdk: ${jdkInstall.dir} (${jdkRelease.name} ${jdkCheck.version}; sha256 ${jdkInstall.sha256} from ${jdkInstall.hashSource})`,
    `  doctor: Ghidra provider PASS (${upstreamChecks.doctor.checks}/${upstreamChecks.doctor.checks} provider checks; observed Ghidra ${upstreamChecks.doctor.providerVersion})`,
    `  tools: PASS (${upstreamChecks.mcp.tools} tools, ${upstreamChecks.mcp.prompts} prompts; observed rea ${upstreamChecks.mcp.packageVersion})`,
    `  analysis: PASS (${upstreamChecks.analysis.evidenceId}; observed Ghidra ${upstreamChecks.analysis.providerVersion})`,
    '  next: rea-shim --doctor',
  ];
  if (upstreamChecks.doctor.globalHealthy !== true) {
    summary.push('  note: rea doctor\'s unrelated setup checks (skill/registrations) are outside this engine gate');
  }
  const shadowing = [];
  for (const name of [discovery.GHIDRA_OVERRIDE_ENV, ...discovery.LEGACY_GHIDRA_ENVS, discovery.JDK_ENV, ...discovery.LEGACY_JDK_ENVS]) {
    if (env[name]) shadowing.push(`${name}=${env[name]}`);
  }
  if (shadowing.length > 0) {
    summary.push(`  note: existing env still wins for normal runs: ${shadowing.join(', ')}`);
    summary.push('        unset those variables to let the bootstrap install be discovered.');
  }
  fs.writeSync(1, summary.join('\n') + '\n');
  return {
    upstream: upstreamInstall,
    policy,
    ghidra: { ...ghidraRelease, ...ghidraInstall, check: ghidraCheck },
    jdk: { ...jdkRelease, ...jdkInstall, check: jdkCheck },
    checks: upstreamChecks,
  };
}

module.exports = {
  parseJavaHome,
  parseJavaMajor,
  parseJavaVersionString,
  runBootstrap,
  verifyGhidra,
  verifyJdk,
};
