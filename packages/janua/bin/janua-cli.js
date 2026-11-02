#!/usr/bin/env node
// The direct entry: no pointer, no child process.
//
// `bin/janua.js` spawns this file from whichever version `current.json` names,
// so a version directory is always run through its own copy. With no pointer
// (a checkout, a fresh npx install) the launcher runs the same code in-process.

import { main } from '../lib/cli.js';

await main(process.argv.slice(2));
