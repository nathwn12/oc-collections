#!/usr/bin/env node
'use strict';
//
// rea-shim: one command, no arguments.
//
// It verifies the pinned portable payload, installs it under the user profile,
// writes one first-run setting when none exists, and starts the window. No
// elevation, no path edits, no background service and no extra setup.
//

const fs = require('node:fs');

const { run } = require('../lib/craft.js');
const PKG = require('../package.json');

const NAME = 'rea-shim';

function failLine(message) {
  fs.writeSync(2, `${NAME}: ${message}\n`);
}

function usage(exitCode, stream) {
  const text = [
    `usage: ${NAME} [--version | --help]`,
    '',
    '  (no args)   verify the pinned Craft Anything payload, install it without',
    '              elevation and start its window',
    '  --version   print the shim version',
    '  --help, -h  print this usage',
    '',
  ].join('\n');
  fs.writeSync(stream === process.stderr ? 2 : 1, text);
  process.exitCode = exitCode;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    if (args.length !== 1) {
      usage(2, process.stderr);
      return;
    }
    usage(0, process.stdout);
    return;
  }
  if (args.includes('--version')) {
    if (args.length !== 1) {
      usage(2, process.stderr);
      return;
    }
    fs.writeSync(1, `${PKG.version}\n`);
    return;
  }
  if (args.length > 0) {
    usage(2, process.stderr);
    return;
  }
  run().catch((error) => {
    failLine(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  });
}

if (require.main === module) main();

module.exports = { main };
