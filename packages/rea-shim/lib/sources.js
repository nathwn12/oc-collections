'use strict';
//
// The one admitted upstream payload.
//
// Trust is a release-prep fact: the official v0.6.1 checksum was verified
// against the signed upstream checksum file and both bundled executables
// carried a valid Authenticode chain. That work is not repeated at runtime.
// Runtime trust is the exact SHA-256 below, checked with native Node crypto
// before any extraction. No other platform or architecture is admitted until
// it carries its own independently pinned and verified hash.
//

function fail(message) {
  throw new Error(message);
}

const CRAFT_SOURCE = Object.freeze({
  name: 'Craft Anything',
  version: '0.6.1',
  tag: 'v0.6.1',
  fileName: 'craft-anything-0.6.1-windows-x64-portable.zip',
  url: 'https://github.com/storytold/craft-anything/releases/download/v0.6.1/craft-anything-0.6.1-windows-x64-portable.zip',
  bytes: 69934191,
  sha256: 'bd370fbaa2b44dbc13581db5ffd2bf66924ed40e433c7902212aa17ca781de54',
  archiveRoot: 'craft-anything-0.6.1-windows-x64-portable',
  exeName: 'craft-anything.exe',
  cliExeName: 'craft-anything-cli.exe',
  portableMarker: 'portable.txt',
  configEnv: 'CRAFT_ANYTHING_CONFIG_DIR',
  settingsVersion: 3,
});

const ARCH_MAP = Object.freeze({ 'win32-x64': CRAFT_SOURCE });

function resolveSource(platform = process.platform, arch = process.arch) {
  const source = ARCH_MAP[`${platform}-${arch}`];
  if (!source) {
    fail(
      `Craft Anything is pinned for Windows x64 only; this host is ${platform}/${arch}. ` +
      'Refusing to guess a payload or a hash for another architecture.',
    );
  }
  return source;
}

module.exports = { ARCH_MAP, CRAFT_SOURCE, resolveSource };
