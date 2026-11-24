'use strict';
//
// Stub for the bundled command-line executable. It answers one JSON-RPC frame
// per input line, writes one line to stderr, and exits with FAKE_CLI_EXIT.
// Nothing here writes to stdout except the response frames.
//

const fs = require('node:fs');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const response = {
      jsonrpc: '2.0',
      id: message.id,
      result: { echo: message.params && message.params.value },
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
});
process.stdin.on('end', () => {
  fs.writeSync(2, 'fake-cli: stderr passthrough\n');
  process.exit(Number(process.env.FAKE_CLI_EXIT || 0));
});
