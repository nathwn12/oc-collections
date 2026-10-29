'use strict';
//
// Official upstream version resolution.
//
// Three rules matter here:
//   1. The rea-agents version used for a bootstrap is an exact, immutable
//      release. A dist-tag is never accepted for bootstrap.
//   2. The accepted Ghidra release line is read from the installed upstream
//      release's own `dist/ghidra/GhidraReleasePolicy.js`. There is no shim
//      version table to go stale. If that module moves or disappears, the
//      bootstrap fails instead of guessing.
//   3. Ghidra and JDK archives are official releases. Their SHA-256 comes from
//      official release data (GitHub release asset digest/sidecar/body,
//      Adoptium API checksum), never from a shim-owned hash constant.
//

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { fetchJson, fetchText, fail, isPlainFile, npmChildEnv } = require('./support.js');

const REA_PACKAGE = 'rea-agents';
const GHIDRA_REPO = 'NationalSecurityAgency/ghidra';
const GHIDRA_RELEASES_URL = `https://api.github.com/repos/${GHIDRA_REPO}/releases`;
const ADOPTIUM_LATEST_URL = (feature) =>
  `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse`;

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;

function normalizeExactVersion(raw, label = 'version') {
  let value = String(raw || '').trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim();
  if (!EXACT_VERSION.test(value)) {
    fail(`${label} '${value}' is not an exact released version (x.y.z); bootstrap never follows a dist-tag`);
  }
  return value;
}

function normalizeIntegrity(raw) {
  let value = String(raw || '').trim();
  if (!value) return null;
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).trim();
  return /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(value) ? value : null;
}

/**
 * Run one npm metadata command.
 *
 * `npmCache` is the validated canonical cache path for a bootstrapping run;
 * a read-only plan run passes `null` so npm uses its own configured cache.
 * Either way the child environment is rebuilt by `npmChildEnv`: an inherited
 * `NPM_CONFIG_CACHE` in any spelling is removed first, because Windows matches
 * environment names case-insensitively and the inherited value would win.
 */
function defaultRunNpm(args, options = {}) {
  try {
    const output = execFileSync('cmd.exe', ['/d', '/c', 'npm', ...args], {
      encoding: 'utf8',
      timeout: options.timeoutMs || 60000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: npmChildEnv(options.env || process.env, options.npmCache || null, {
        npm_config_fund: 'false',
        npm_config_audit: 'false',
        npm_config_update_notifier: 'false',
        npm_config_loglevel: 'error',
      }),
    });
    return String(output || '').trim();
  } catch (error) {
    const stderr = String((error && error.stderr) || '').trim();
    fail(`npm ${args.join(' ')} failed: ${stderr ? stderr.slice(-1000) : error.message}`);
  }
  return null;
}

function resolveUpstreamRelease(options = {}) {
  const env = options.env || process.env;
  const runNpm = options.runNpm || defaultRunNpm;
  const pin = env.REA_SHIM_AGENTS_VERSION;
  let version;
  let source;
  if (pin) {
    version = normalizeExactVersion(pin, 'REA_SHIM_AGENTS_VERSION');
    source = `REA_SHIM_AGENTS_VERSION=${pin}`;
  } else {
    version = normalizeExactVersion(runNpm(['view', REA_PACKAGE, 'version']), 'npm dist-tag latest');
    source = 'npm dist-tag latest';
  }
  let integrity = null;
  if (options.integrity !== false) {
    try {
      integrity = normalizeIntegrity(runNpm(['view', `${REA_PACKAGE}@${version}`, 'dist.integrity', '--json']));
    } catch {
      // The installed package's own package.json and the upstream checks still
      // pin the exact version; the registry integrity is a recorded extra.
    }
  }
  return { version, source, integrity };
}

function parseGhidraVersion(raw) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(raw || '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    text: String(raw).trim(),
  };
}

function parseGhidraTag(tag) {
  const match = /^Ghidra_(\d+)\.(\d+)(?:\.(\d+))?_build$/.exec(String(tag || '').trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    version: match[3] === undefined ? `${match[1]}.${match[2]}` : `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function parseGhidraAsset(name) {
  const match = /^ghidra_(\d+\.\d+(?:\.\d+)?)_PUBLIC_(\d{8})\.zip$/.exec(String(name || '').trim());
  if (!match) return null;
  return { version: match[1], build: match[2] };
}

function selectGhidraRelease(releases, supportedVersion) {
  const supported = parseGhidraVersion(supportedVersion);
  if (!supported) fail(`upstream reported an unparseable supported Ghidra version: ${supportedVersion}`);
  const candidates = [];
  if (!Array.isArray(releases)) fail('GitHub releases response is not an array');
  for (const release of releases) {
    if (!release || release.draft === true || release.prerelease === true) continue;
    const tag = parseGhidraTag(release.tag_name);
    if (!tag || tag.major !== supported.major || tag.minor !== supported.minor) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const matches = assets.filter((asset) => {
      const parsed = parseGhidraAsset(asset && asset.name);
      return parsed && parsed.version === tag.version;
    });
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      fail(`official Ghidra release ${release.tag_name} has more than one public ZIP asset`);
    }
    candidates.push({ release, tag, asset: matches[0] });
  }
  if (candidates.length === 0) {
    fail(
      `no published official NSA Ghidra release exists in the upstream-supported ` +
      `${supported.major}.${supported.minor}.x line; refusing to install an unsupported line`,
    );
  }
  candidates.sort((left, right) =>
    (right.tag.patch - left.tag.patch) ||
    String(parseGhidraAsset(right.asset.name).build).localeCompare(String(parseGhidraAsset(left.asset.name).build)));
  return candidates[0];
}

function shaFromDigest(value) {
  if (typeof value !== 'string') return null;
  const match = /^sha256:([0-9a-f]{64})$/i.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pull a SHA-256 for one exact filename out of release notes or a checksum
 * file. Multiple distinct hashes for that filename are ambiguous and fail.
 */
function hashFromText(text, fileName, options = {}) {
  if (!text) return null;
  if (options.requireFilenameMention && !String(text).includes(fileName)) return null;
  const escaped = escapeRegExp(fileName);
  const filenamePatterns = [
    new RegExp(`^\\s*([0-9a-f]{64})\\s+\\*?${escaped}\\s*$`, 'gim'),
    new RegExp(`^\\s*${escaped}\\s*[:=]?\\s*\\*?([0-9a-f]{64})\\s*$`, 'gim'),
    new RegExp(`sha-?256\\s*\\(\\s*${escaped}\\s*\\)\\s*[:=]?\\s*([0-9a-f]{64})`, 'gim'),
    new RegExp(`^\\s*\\|\\s*${escaped}\\s*\\|\\s*([0-9a-f]{64})\\s*\\|`, 'gim'),
  ];
  const collect = (patterns) => {
    const hashes = new Set();
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) hashes.add(match[1].toLowerCase());
    }
    return hashes;
  };
  const tied = collect(filenamePatterns);
  if (tied.size > 1) {
    fail(`official release data lists conflicting SHA-256 values for ${fileName}: ${[...tied].join(', ')}`);
  }
  if (tied.size === 1) return [...tied][0];

  // Only when no hash is tied to the filename do we fall back to a lone
  // generic SHA-256 value. Multiple unrelated hashes are ambiguous.
  const generic = collect([new RegExp('sha-?256\\s*[:=]\\s*([0-9a-f]{64})', 'gim')]);
  if (generic.size > 1) {
    fail(`official release data lists multiple SHA-256 values and none is tied to ${fileName}`);
  }
  if (generic.size === 1) return [...generic][0];
  if (options.allowBareHash) {
    const all = String(text).match(/\b[0-9a-f]{64}\b/gi) || [];
    const unique = [...new Set(all.map((value) => value.toLowerCase()))];
    if (unique.length === 1) return unique[0];
    if (unique.length > 1) {
      fail(`checksum data for ${fileName} is ambiguous (${unique.length} hashes, none tied to the filename)`);
    }
  }
  return null;
}

function checksumAssetNames(zipName) {
  return new Set([
    `${zipName}.sha256`,
    `${zipName}.sha256.txt`,
    `${zipName}.sha256sum`,
    `${zipName}.sha256sum.txt`,
  ]);
}

async function resolveGhidraHash(candidate, options = {}) {
  const fetchTextFn = options.fetchText || fetchText;
  const { release, asset } = candidate;
  const digest = shaFromDigest(asset.digest);
  if (digest) return { sha256: digest, source: 'GitHub release asset digest' };

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const wanted = checksumAssetNames(asset.name);
  const checksumAssets = assets.filter((entry) => entry && entry.name !== asset.name && (
    wanted.has(entry.name) ||
    /(?:sha256|checksums?)/i.test(entry.name)
  ));
  const seenChecksumAssets = new Set();
  const found = new Set();
  for (const checksumAsset of checksumAssets) {
    if (seenChecksumAssets.has(checksumAsset.name)) continue;
    seenChecksumAssets.add(checksumAsset.name);
    if (!/^https:\/\//.test(String(checksumAsset.browser_download_url || ''))) {
      fail(`official checksum asset ${checksumAsset.name} is not served over HTTPS`);
    }
    const text = await fetchTextFn(checksumAsset.browser_download_url, { maxBytes: 64 * 1024 });
    const hash = hashFromText(text, asset.name, { allowBareHash: true });
    if (hash) found.add(hash);
  }
  if (found.size > 1) {
    fail(`official checksum assets disagree for ${asset.name}: ${[...found].join(', ')}`);
  }
  if (found.size === 1) return { sha256: [...found][0], source: 'official release checksum asset' };

  const bodyHash = hashFromText(release.body, asset.name, { allowBareHash: true, requireFilenameMention: true });
  if (bodyHash) return { sha256: bodyHash, source: 'official release notes' };

  fail(
    `official Ghidra release ${release.tag_name} publishes no verifiable SHA-256 for ` +
    `${asset.name}; refusing to install an unverified archive`,
  );
}

async function fetchGhidraReleases(options = {}) {
  const fetchJsonFn = options.fetchJson || fetchJson;
  const pages = [];
  for (let page = 1; page <= 3; page += 1) {
    const items = await fetchJsonFn(`${GHIDRA_RELEASES_URL}?per_page=100&page=${page}`, {
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      maxBytes: 32 * 1024 * 1024,
    });
    if (items && !Array.isArray(items) && typeof items.message === 'string') {
      fail(`GitHub releases API refused the request: ${items.message}`);
    }
    if (!Array.isArray(items)) fail('GitHub releases API did not return an array');
    pages.push(...items);
    if (items.length < 100) break;
  }
  return pages;
}

async function resolveGhidraRelease(options = {}) {
  const supportedVersion = options.supportedVersion;
  const releases = options.releases || await fetchGhidraReleases(options);
  const candidate = selectGhidraRelease(releases, supportedVersion);
  const hash = await resolveGhidraHash(candidate, options);
  const url = String(candidate.asset.browser_download_url || '');
  if (!/^https:\/\/github\.com\/NationalSecurityAgency\/ghidra\/releases\/download\//.test(url)) {
    fail(`official Ghidra asset URL is not the NSA GitHub release path: ${url}`);
  }
  const parsed = parseGhidraVersion(candidate.tag.version);
  return {
    kind: 'ghidra',
    name: 'Ghidra',
    version: parsed.text,
    build: parseGhidraAsset(candidate.asset.name).build,
    fileName: candidate.asset.name,
    url,
    sha256: hash.sha256,
    hashSource: hash.source,
    releaseUrl: String(candidate.release.html_url || ''),
    tag: candidate.release.tag_name,
  };
}

function compareSemverText(a, b) {
  const pa = String(a).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const difference = (pb[index] || 0) - (pa[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function selectJdkRelease(assets, requirement) {
  if (!Array.isArray(assets)) fail('Adoptium API response is not an array');
  const candidates = [];
  for (const item of assets) {
    const binary = item && item.binary;
    const pkg = binary && binary.package;
    const version = item && item.version;
    if (!binary || !pkg || !version) continue;
    if (binary.image_type !== 'jdk' || binary.os !== 'windows' || binary.architecture !== 'x64') continue;
    const major = Number(version.major);
    if (!Number.isInteger(major)) continue;
    if (major < requirement.minimum) continue;
    if (requirement.maximum !== null && major > requirement.maximum) continue;
    if (typeof pkg.name !== 'string' || !pkg.name.endsWith('.zip')) continue;
    if (typeof pkg.link !== 'string' || !/^https:\/\//.test(pkg.link)) continue;
    if (!/^https:\/\/(?:github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|adoptium\.net)\//.test(pkg.link)) continue;
    if (typeof pkg.checksum !== 'string' || !SHA256.test(pkg.checksum.toLowerCase())) continue;
    candidates.push({ item, binary, pkg, version, major });
  }
  if (candidates.length === 0) {
    fail(
      `no official Eclipse Temurin x64 Windows JDK satisfies the installed Ghidra's declared ` +
      `Java ${requirement.minimum}${requirement.maximum === null ? '+' : `..${requirement.maximum}`} requirement`,
    );
  }
  candidates.sort((left, right) => compareSemverText(
    left.version.semver || left.version.openjdk_version || '',
    right.version.semver || right.version.openjdk_version || '',
  ));
  const chosen = candidates[0];
  const releaseName = String(chosen.item.release_name || chosen.version.openjdk_version || `jdk-${chosen.major}`);
  const dirLabel = releaseName.replace(/^jdk-/, '').replace(/[^0-9A-Za-z._+-]/g, '-');
  const dirName = `temurin-${dirLabel}`;
  return {
    kind: 'jdk',
    name: 'Eclipse Temurin JDK',
    version: releaseName,
    major: chosen.major,
    fileName: chosen.pkg.name,
    url: chosen.pkg.link,
    sha256: chosen.pkg.checksum.toLowerCase(),
    hashSource: 'Adoptium API binary.package.checksum',
    dirName,
  };
}

async function resolveJdkRelease(options = {}) {
  const requirement = options.requirement;
  if (!requirement || !Number.isInteger(requirement.minimum)) {
    fail('cannot resolve a JDK without the installed Ghidra Java requirement');
  }
  const fetchJsonFn = options.fetchJson || fetchJson;
  const assets = await fetchJsonFn(ADOPTIUM_LATEST_URL(requirement.minimum), { maxBytes: 4 * 1024 * 1024 });
  return selectJdkRelease(assets, requirement);
}

/**
 * Read the accepted Ghidra release line from the exact upstream release that
 * was installed. This module is the upstream policy; the shim does not carry a
 * second copy that can drift. Upstream's source of truth is `morluto/rea`
 * main; each published release packages that policy. When main raises the
 * requirement, update the release the shim installs, not a shim constant.
 */
async function readUpstreamPolicy(prefix) {
  const packageDir = path.join(prefix, 'node_modules', REA_PACKAGE);
  const policyPath = path.join(packageDir, 'dist', 'ghidra', 'GhidraReleasePolicy.js');
  if (!isPlainFile(policyPath)) {
    fail(
      `the installed ${REA_PACKAGE} release has no readable Ghidra release policy at ${policyPath}; ` +
      'bootstrap refuses to guess which Ghidra line upstream supports',
    );
  }
  let policy;
  try {
    policy = await import(pathToFileURL(policyPath).href);
  } catch (error) {
    fail(`cannot load the upstream Ghidra release policy at ${policyPath}: ${error.message}`);
  }
  const supportedVersion = policy && policy.SUPPORTED_GHIDRA_VERSION;
  const parsed = parseGhidraVersion(supportedVersion);
  if (!parsed) {
    fail(`upstream Ghidra release policy does not export a parseable SUPPORTED_GHIDRA_VERSION (${supportedVersion})`);
  }
  if (typeof policy.ghidraReleaseAccepted !== 'function' || policy.ghidraReleaseAccepted(supportedVersion) !== true) {
    fail(`upstream Ghidra release policy does not accept its own SUPPORTED_GHIDRA_VERSION ${supportedVersion}`);
  }
  let line;
  try {
    line = typeof policy.ghidraReleaseLine === 'function' ? policy.ghidraReleaseLine() : null;
  } catch {
    line = null;
  }
  if (!line) line = `${parsed.major}.${parsed.minor}.x`;
  return {
    supportedVersion,
    line,
    policyPath,
    packageDir,
    accepts: (value) => policy.ghidraReleaseAccepted(value) === true,
  };
}

module.exports = {
  ADOPTIUM_LATEST_URL,
  EXACT_VERSION,
  GHIDRA_RELEASES_URL,
  REA_PACKAGE,
  checksumAssetNames,
  defaultRunNpm,
  fetchGhidraReleases,
  hashFromText,
  normalizeExactVersion,
  normalizeIntegrity,
  parseGhidraAsset,
  parseGhidraTag,
  parseGhidraVersion,
  readUpstreamPolicy,
  resolveGhidraHash,
  resolveGhidraRelease,
  resolveJdkRelease,
  resolveUpstreamRelease,
  selectGhidraRelease,
  selectJdkRelease,
  shaFromDigest,
};
