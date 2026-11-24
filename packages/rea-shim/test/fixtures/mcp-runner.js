'use strict';
//
// Drives the real runMcp path with the bundled executable replaced by the
// fake CLI. The caller supplies a staged archive so no network is used.
//

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const craft = require('../../lib/craft.js');
const sources = require('../../lib/sources.js');

const zip = process.env.FIXTURE_ZIP;
const root = process.env.FIXTURE_ROOT;
const bytes = fs.readFileSync(zip);
const source = {
  ...sources.CRAFT_SOURCE,
  url: 'https://example.invalid/fake.zip',
  sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
};
const stub = path.join(__dirname, 'mcp-fake-cli.js');

craft.runMcp({
  root,
  source,
  env: { ...process.env },
  platform: 'win32',
  arch: 'x64',
  spawn: (file, args, options) => spawn(process.execPath, [stub], options),
}).catch((error) => {
  fs.writeSync(2, `runner: ${error.message}\n`);
  process.exitCode = 1;
});
