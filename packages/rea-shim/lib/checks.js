'use strict';
//
// Upstream acceptance checks.
//
// These run the exact installed rea-agents release (never a different npx
// resolution between checks), with the exact JDK and Ghidra pair this
// bootstrap installed. Each gate requires its observed identity: the
// package/server version for doctor and MCP, the Ghidra provider version for
// analysis.
//
// `evaluate*` are pure contracts over upstream JSON; `runUpstreamChecks` is
// the only part that executes anything.
//

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  ensurePlainDir,
  fail,
  randomSuffix,
} = require('./support.js');

const ENGINE_PROBE = Buffer.from([
  0xa9, 0x01, 0x8d, 0x00, 0x02, 0x60, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea,
]);

const GHIDRA_PROVIDER_CHECKS = [
  'configuration',
  'platform',
  'architecture',
  'installation',
  'version',
  'headless',
  'native_decompiler',
  'java',
];

function parseJsonOutput(text, label, result) {
  const raw = String(text || '').trim();
  if (!raw) {
    const stderr = String(result && result.stderr ? result.stderr : '').trim();
    fail(`${label} produced no output${stderr ? `; stderr: ${stderr.slice(-2000)}` : ''}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // Fall through to the readable failure below.
      }
    }
    fail(`${label} did not return JSON: ${raw.slice(0, 500)}`);
  }
  return null;
}

function requireOk(label, check) {
  if (!check) fail(`${label} was not reported by rea doctor`);
  if (check.ok !== true) {
    const detail = check.detail ? `: ${check.detail}` : '';
    const remediation = check.remediation ? ` (fix: ${check.remediation})` : '';
    fail(`${label} failed${detail}${remediation}`);
  }
}

function providerCheckMap(report) {
  const provider = Array.isArray(report.providerInspections)
    ? report.providerInspections.find((entry) => entry && entry.id === 'ghidra')
    : null;
  if (!provider) fail('rea doctor did not report a Ghidra provider inspection');
  if (provider.available !== true) fail('rea doctor did not report the Ghidra provider as available');
  const checks = new Map(
    (Array.isArray(provider.checks) ? provider.checks : [])
      .filter((check) => check && typeof check.name === 'string')
      .map((check) => [check.name, check]),
  );
  return { provider, checks };
}

/**
 * The Ghidra provider gate. Global `healthy` is deliberately not required:
 * a clean host has no REA skill registration yet, and those informational
 * checks are not part of "the engine works". Every Ghidra provider check must
 * be green, and the observed provider version must be named and exact.
 */
function evaluateDoctorReport(report, expected) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    fail('rea doctor returned no JSON object');
  }
  const { provider, checks } = providerCheckMap(report);
  if (!provider.providerVersion) {
    fail('rea doctor did not report the observed Ghidra provider version');
  }
  if (provider.providerVersion !== expected.version) {
    fail(`rea doctor saw Ghidra ${provider.providerVersion}, expected ${expected.version}`);
  }
  if (!expected.agentsVersion) fail('rea doctor gate needs the exact expected rea-agents version');
  const identity = report.identity || {};
  if (!identity.cli_package_version) {
    fail('rea doctor did not report the observed CLI package version');
  }
  if (identity.cli_package_version !== expected.agentsVersion) {
    fail(`rea doctor observed rea-agents ${identity.cli_package_version}, expected ${expected.agentsVersion}`);
  }
  for (const name of GHIDRA_PROVIDER_CHECKS) {
    requireOk(`rea doctor Ghidra ${name} check`, checks.get(name));
  }
  return {
    providerVersion: provider.providerVersion,
    checks: GHIDRA_PROVIDER_CHECKS.length,
    globalHealthy: report.healthy === true,
  };
}

function evaluateMcpDoctorReport(report, expected) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    fail('rea mcp doctor returned no JSON object');
  }
  if (report.healthy !== true) fail('rea mcp doctor reported the server is not healthy');
  const server = report.server || {};
  if (server.name !== 'rea') fail(`rea mcp doctor reported server '${server.name}', expected 'rea'`);
  if (!server.version) fail('rea mcp doctor did not report the observed server version');
  if (server.version !== expected.version) {
    fail(`rea mcp doctor reported server version ${server.version}, expected ${expected.version}`);
  }

  const tools = report.inventory && report.inventory.tools;
  const prompts = report.inventory && report.inventory.prompts;
  if (!tools || typeof tools !== 'object') fail('rea mcp doctor reported no tool inventory');
  if (!prompts || typeof prompts !== 'object') fail('rea mcp doctor reported no prompt inventory');
  if (Number(tools.expected) !== Number(tools.observed)) {
    fail(`rea mcp doctor observed ${tools.observed} tools, expected ${tools.expected}`);
  }
  if (Number(prompts.expected) !== Number(prompts.observed)) {
    fail(`rea mcp doctor observed ${prompts.observed} prompts, expected ${prompts.expected}`);
  }
  for (const key of ['missing', 'unexpected', 'duplicates']) {
    for (const [label, inventory] of [['tools', tools], ['prompts', prompts]]) {
      const value = inventory[key];
      if (Array.isArray(value) && value.length > 0) {
        fail(`rea mcp doctor found ${key} ${label}: ${value.join(', ')}`);
      }
    }
  }

  const identity = report.identity || {};
  if (!identity.expected_package_version) fail('rea mcp doctor reported no expected package version');
  if (!identity.observed_package_version) fail('rea mcp doctor reported no observed package version');
  if (identity.expected_package_version !== expected.version) {
    fail(`rea mcp doctor expected package ${identity.expected_package_version}, bootstrap installed ${expected.version}`);
  }
  if (identity.observed_package_version !== expected.version) {
    fail(`rea mcp doctor observed package ${identity.observed_package_version}, expected ${expected.version}`);
  }
  if (!identity.expected_catalog_digest || !identity.observed_catalog_digest) {
    fail('rea mcp doctor did not report both catalog digests');
  }
  if (identity.expected_catalog_digest !== identity.observed_catalog_digest) {
    fail('rea mcp doctor catalog digest did not match the installed package');
  }
  if (!report.request_flow || report.request_flow.ok !== true) {
    fail('rea mcp doctor request flow failed');
  }
  return {
    tools: Number(tools.observed),
    prompts: Number(prompts.observed),
    packageVersion: identity.observed_package_version,
  };
}

/**
 * `rea analyze --full-output --format json` returns the CLI result envelope
 * `{ ok: true, data: <evidence>, meta }`. The evidence record itself carries
 * `evidence_id`, `subject` and `analysis_profile`; those are never top-level
 * fields of the CLI response. Requiring the envelope means an error document,
 * a bare evidence record or a truncated response cannot be mistaken for a
 * successful analysis.
 */
function analysisEvidence(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    fail('rea analyze returned no JSON object');
  }
  if (report.ok !== true) {
    const error = report.error && typeof report.error === 'object'
      ? [report.error.code, report.error.message].filter(Boolean).join(': ')
      : '';
    fail(`rea analyze did not return an ok:true CLI envelope${error ? `: ${error}` : ''}`);
  }
  const data = report.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    fail('rea analyze returned no evidence data in its CLI envelope');
  }
  return data;
}

function evaluateAnalysisReport(report, expected) {
  const evidence = analysisEvidence(report);
  const profile = evidence.analysis_profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    fail('rea analyze returned no analysis profile');
  }
  const upstream = profile.parameters && profile.parameters.upstream_analysis_profile;
  const provider = upstream && upstream.provider;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider) || provider.id !== 'ghidra') {
    fail(`rea analyze did not run through the Ghidra provider${provider && provider.id ? ` (used ${provider.id})` : ''}`);
  }
  if (!provider.name || typeof provider.name !== 'string') {
    fail('rea analyze did not report the Ghidra provider identity');
  }
  if (!provider.version || typeof provider.version !== 'string') {
    fail('rea analyze did not report the observed Ghidra provider version');
  }
  if (provider.version !== expected.version) {
    fail(`rea analyze used Ghidra ${provider.version}, expected ${expected.version}`);
  }
  if (!evidence.evidence_id || typeof evidence.evidence_id !== 'string') {
    fail('rea analyze produced no evidence id');
  }
  const subject = evidence.subject;
  if (!subject || subject.format !== 'raw-binary' || subject.architecture !== '6502') {
    fail('rea analyze did not return a raw-binary 6502 subject');
  }
  return { evidenceId: evidence.evidence_id, providerVersion: provider.version };
}

function formatCommandFailure(label, result, report) {
  const parts = [];
  if (result && result.signal) parts.push(`terminated by ${result.signal}`);
  if (result && typeof result.status === 'number' && result.status !== 0) parts.push(`exit ${result.status}`);
  if (report && typeof report === 'object') {
    if (report.code) parts.push(String(report.code));
    if (report.error) parts.push(String(report.error));
    if (report.message) parts.push(String(report.message));
  }
  const stderr = String(result && result.stderr ? result.stderr : '').trim();
  if (stderr) parts.push(stderr.slice(-2000));
  return `${label} failed${parts.length ? `: ${parts.join('; ')}` : ''}`;
}

function formatAnalysisFailure(result, report) {
  const parts = [];
  if (report && typeof report === 'object') {
    if (report.error) parts.push(String(report.error));
    if (report.message) parts.push(String(report.message));
    const rejections = report.details && Array.isArray(report.details.rejections) ? report.details.rejections : [];
    const ghidra = rejections.find((rejection) => rejection && rejection.provider_id === 'ghidra');
    if (ghidra && ghidra.reason) parts.push(`ghidra: ${ghidra.reason}`);
  }
  if (result && typeof result.status === 'number' && result.status !== 0) parts.push(`exit ${result.status}`);
  const stderr = String(result && result.stderr ? result.stderr : '').trim();
  if (stderr) parts.push(stderr.slice(-1000));
  return `rea analyze failed${parts.length ? `: ${parts.join('; ')}` : ''}`;
}

function killProcessTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30000,
    });
  } catch {
    // The direct child is already gone; this is best-effort cleanup.
  }
}

function runCaptured(command, args, options = {}) {
  return new Promise((resolve) => {
    const maxBytes = options.maxBuffer || 64 * 1024 * 1024;
    const timeoutMs = options.timeoutMs || 300000;
    let stdout = '';
    let stderr = '';
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    let timer = null;

    const child = spawn(command, args, {
      env: options.env || process.env,
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      let error = result.error || null;
      if (outputExceeded && !error) error = new Error(`output exceeded ${maxBytes} bytes`);
      if (timedOut && !error) error = new Error(`timed out after ${timeoutMs} ms`);
      resolve({
        status: result.status,
        signal: result.signal,
        stdout,
        stderr,
        error,
      });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
      }, timeoutMs);
    }
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (stdout.length + chunk.length > maxBytes) {
          outputExceeded = true;
          killProcessTree(child.pid);
          return;
        }
        stdout += chunk.toString('utf8');
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length + chunk.length > maxBytes) {
          outputExceeded = true;
          killProcessTree(child.pid);
          return;
        }
        stderr += chunk.toString('utf8');
      });
    }
    child.on('error', (error) => finish({ status: null, signal: null, error }));
    child.on('close', (status, signal) => finish({ status, signal, error: null }));
  });
}

function defaultRunScript({ script, args, env, cwd, timeoutMs }) {
  return runCaptured(process.execPath, [script, ...args], { env, cwd, timeoutMs });
}

function childEnv(jdkHome, ghidraDir, base = process.env) {
  return {
    ...base,
    GHIDRA_INSTALL_DIR: ghidraDir,
    JAVA_HOME: jdkHome,
    PATH: `${path.join(jdkHome, 'bin')};${base.PATH || ''}`,
    REA_GHIDRA_STARTUP_TIMEOUT_MS: '1500000',
  };
}

/**
 * Run, in order, against one installed pair and one exact upstream version:
 *   1. `rea doctor --provider ghidra --format json` (provider readiness)
 *   2. `rea mcp doctor --json` (server startup + complete tool inventory)
 *   3. `rea analyze <6502 fixture> --provider ghidra ...` (headless engine)
 * Any failure throws; none is downgraded to a warning.
 */
async function runUpstreamChecks(options = {}) {
  const {
    agentsVersion,
    script,
    env,
    tempDir,
    ghidra,
    run = defaultRunScript,
    log = () => {},
    timeouts = {},
  } = options;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(agentsVersion || ''))) {
    fail(`runUpstreamChecks needs an exact agents version, got '${agentsVersion}'`);
  }
  if (!script) fail('runUpstreamChecks needs the installed rea script path');
  if (!ghidra || !ghidra.version) fail('runUpstreamChecks needs the installed Ghidra version');
  if (!tempDir) fail('runUpstreamChecks needs a temporary directory');

  ensurePlainDir(tempDir, 'temporary directory');
  const call = (label, args, timeoutMs) => run({
    label,
    script,
    args,
    env,
    cwd: tempDir,
    timeoutMs,
    agentsVersion,
  });

  log(`upstream doctor: rea-agents@${agentsVersion} doctor --provider ghidra --format json`);
  const doctorResult = await call('doctor', ['doctor', '--provider', 'ghidra', '--format', 'json'], timeouts.doctorMs || 300000);
  if (doctorResult.error) fail(`rea doctor could not run: ${doctorResult.error.message}`);
  const doctorReport = parseJsonOutput(doctorResult.stdout, 'rea doctor', doctorResult);
  if (doctorResult.signal || doctorResult.status === null) {
    fail(formatCommandFailure('rea doctor', doctorResult, doctorReport));
  }
  let doctor;
  try {
    doctor = evaluateDoctorReport(doctorReport, { ...ghidra, agentsVersion });
  } catch (error) {
    fail(`${formatCommandFailure('rea doctor', doctorResult, doctorReport)}; ${error.message}`);
  }
  if (doctorResult.status !== 0) {
    // A clean host has no REA skill/registration yet, so the global doctor
    // exit is non-zero even when every Ghidra provider check is green. The
    // provider gate above is the engine contract; the global checks are not.
    log(`upstream doctor: Ghidra provider PASS; rea doctor exit ${doctorResult.status} is from unrelated setup checks`);
  } else {
    log(`upstream doctor: Ghidra provider PASS (Ghidra ${doctor.providerVersion})`);
  }

  log(`upstream tools: rea-agents@${agentsVersion} mcp doctor --json`);
  const mcpResult = await call('mcp', ['mcp', 'doctor', '--json'], timeouts.mcpDoctorMs || 300000);
  if (mcpResult.error) fail(`rea mcp doctor could not run: ${mcpResult.error.message}`);
  const mcpReport = parseJsonOutput(mcpResult.stdout, 'rea mcp doctor', mcpResult);
  if (mcpResult.status !== 0) {
    let detail = '';
    try {
      evaluateMcpDoctorReport(mcpReport, { version: agentsVersion });
    } catch (error) {
      detail = `; ${error.message}`;
    }
    fail(`${formatCommandFailure('rea mcp doctor', mcpResult, mcpReport)}${detail}`);
  }
  const mcp = evaluateMcpDoctorReport(mcpReport, { version: agentsVersion });
  log(`upstream tools: PASS (${mcp.tools} tools, ${mcp.prompts} prompts, rea ${mcp.packageVersion})`);

  ensurePlainDir(tempDir, 'temporary directory');
  const fixture = path.join(tempDir, `engine-probe-${process.pid}-${randomSuffix()}.bin`);
  fs.writeFileSync(fixture, ENGINE_PROBE);
  try {
    log(`engine: rea-agents@${agentsVersion} analyze <6502 fixture> --provider ghidra --format json`);
    const analyzeResult = await call('analyze', [
      'analyze',
      fixture,
      '--provider',
      'ghidra',
      '--target-format',
      'raw-binary',
      '--architecture',
      '6502',
      '--entry-point',
      '0x0',
      '--full-output',
      '--format',
      'json',
    ], timeouts.analyzeMs || 1800000);
    if (analyzeResult.error) fail(`rea analyze could not run: ${analyzeResult.error.message}`);
    const analyzeReport = parseJsonOutput(analyzeResult.stdout, 'rea analyze', analyzeResult);
    if (analyzeResult.status !== 0) fail(formatAnalysisFailure(analyzeResult, analyzeReport));
    const analysis = evaluateAnalysisReport(analyzeReport, ghidra);
    log(`engine: PASS (${analysis.evidenceId}; Ghidra ${analysis.providerVersion})`);
    return { doctor, mcp, analysis, packageVersion: agentsVersion };
  } finally {
    try {
      fs.rmSync(fixture, { force: true });
    } catch {
      // The probe is a temporary artifact; the check result is unaffected.
    }
    try {
      if (fs.readdirSync(tempDir).length === 0) fs.rmdirSync(tempDir);
    } catch {
      // Leave a non-empty caller-owned directory alone.
    }
  }
}

module.exports = {
  ENGINE_PROBE,
  GHIDRA_PROVIDER_CHECKS,
  childEnv,
  defaultRunScript,
  evaluateAnalysisReport,
  evaluateDoctorReport,
  evaluateMcpDoctorReport,
  parseJsonOutput,
  runCaptured,
  runUpstreamChecks,
};
