// Offline proof for the wire layer. Every socket here is a Duplex from
// node:stream and every timer is a hand-fired fake, so no test opens a real pipe
// or waits on a clock. A refused connect throws synchronously; the client has to
// survive that too, because a Discord that is not running is the normal case.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import {
  OP,
  encodeFrame,
  createDecoder,
  handshakePayload,
  setActivityPayload,
  pipeCandidates,
  createClient,
} from '../src/ipc.mjs';

// Byte for byte what Discord Canary answered to client id 123456789012345678:
// opcode 2 CLOSE, a 43-byte body, {"code":4000,"message":"Invalid Client ID"}.
const CLOSE_INVALID_CLIENT_ID = Buffer.from(
  '020000002b0000007b22636f6465223a343030302c226d657373616765223a22496e76616c696420436c69656e74204944227d',
  'hex',
);

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function fakeTimers() {
  let next = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = ++next; pending.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pending.delete(id); },
    delays() { return [...pending.values()].map((t) => t.ms); },
    count() { return pending.size; },
    fireAll() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, t] of due) t.fn();
    },
  };
}

function fakeSocket(target) {
  const writes = [];
  const socket = new Duplex({
    read() {},
    write(chunk, enc, cb) { writes.push(Buffer.from(chunk)); cb(); },
  });
  socket.path = target;
  socket.writes = writes;
  socket.frames = () => (writes.length ? createDecoder().push(Buffer.concat(writes)) : []);
  // A Duplex defers pushed readable data to a macrotask. Emitting the event
  // directly keeps every settlement inside the microtask queue.
  socket.receive = (frame) => socket.emit('data', frame);
  return socket;
}

function harness(options = {}) {
  const timers = fakeTimers();
  const sockets = [];
  const paths = [];
  const logs = [];
  let refuse = options.refuse || 0;
  const connect = (target) => {
    paths.push(target);
    if (paths.length <= refuse) throw new Error('ECONNREFUSED ' + target);
    const socket = fakeSocket(target);
    sockets.push(socket);
    queueMicrotask(() => {
      if (options.errorFirst && sockets.length === 1) socket.emit('error', new Error('EPIPE'));
      else if (!options.silent) socket.emit('connect');
    });
    return socket;
  };
  const client = createClient({
    clientId: options.clientId === undefined ? 'test-client' : options.clientId,
    pid: options.pid === undefined ? 4242 : options.pid,
    connect,
    now: options.now || (() => 1000),
    log: options.log || ((...args) => logs.push(args)),
    minIntervalMs: options.minIntervalMs === undefined ? 1000 : options.minIntervalMs,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { client, sockets, paths, timers, logs, setRefuse(n) { refuse = n; } };
}

test('a frame round-trips through encode and decode', () => {
  const payload = { cmd: 'SET_ACTIVITY', args: { pid: 7 } };
  const frame = encodeFrame(OP.FRAME, payload);
  assert.equal(frame.readUInt32LE(0), OP.FRAME);
  assert.equal(frame.readUInt32LE(4), Buffer.byteLength(JSON.stringify(payload), 'utf8'));
  const out = createDecoder().push(frame);
  assert.equal(out.length, 1);
  assert.equal(out[0].op, OP.FRAME);
  assert.deepEqual(out[0].json, payload);
  assert.equal(out[0].raw, JSON.stringify(payload));
});

test('a frame split across three chunks decodes once at the end', () => {
  const payload = { evt: 'READY', data: { ok: true } };
  const frame = encodeFrame(OP.FRAME, payload);
  const decoder = createDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(frame.subarray(3, 11)), []);
  const out = decoder.push(frame.subarray(11));
  assert.equal(out.length, 1);
  assert.equal(out[0].op, OP.FRAME);
  assert.deepEqual(out[0].json, payload);
});

test('two frames in one chunk both come out', () => {
  const one = encodeFrame(OP.PING, '{"nonce":"p1"}');
  const two = encodeFrame(OP.FRAME, { evt: 'READY' });
  const out = createDecoder().push(Buffer.concat([one, two]));
  assert.equal(out.length, 2);
  assert.equal(out[0].op, OP.PING);
  assert.equal(out[0].raw, '{"nonce":"p1"}');
  assert.equal(out[1].op, OP.FRAME);
  assert.deepEqual(out[1].json, { evt: 'READY' });
});

test('a declared length above 1 MiB throws and names the length', () => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(OP.FRAME, 0);
  header.writeUInt32LE(1048577, 4);
  assert.throws(() => createDecoder().push(header), /1048577/);
  const atLimit = Buffer.alloc(8);
  atLimit.writeUInt32LE(OP.FRAME, 0);
  atLimit.writeUInt32LE(1048576, 4);
  assert.deepEqual(createDecoder().push(atLimit), []);
});

test('invalid JSON keeps the raw text and reports null json', () => {
  const out = createDecoder().push(encodeFrame(OP.FRAME, 'not json'));
  assert.equal(out[0].op, OP.FRAME);
  assert.equal(out[0].json, null);
  assert.equal(out[0].raw, 'not json');
});

test('payload shapes: handshake, set activity and the clear form', () => {
  assert.deepEqual(handshakePayload('abc'), { v: 1, client_id: 'abc' });
  const activity = { details: 'playing' };
  const set = setActivityPayload({ pid: 99, nonce: 'n1', activity });
  assert.equal(set, '{"cmd":"SET_ACTIVITY","nonce":"n1","args":{"pid":99,"activity":{"details":"playing"}}}');
  const clear = setActivityPayload({ pid: 99, nonce: 'n1', activity: null });
  assert.equal(clear, '{"cmd":"SET_ACTIVITY","nonce":"n1","args":{"pid":99}}');
  assert.equal(clear.includes('activity'), false);
  assert.equal(setActivityPayload({ pid: 99, nonce: 'n1' }), clear);
});

test('windows candidates use the NT pipe prefix and all ten slots', () => {
  const win = pipeCandidates({ platform: 'win32' });
  assert.equal(win.length, 10);
  assert.equal(win[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(win[9], '\\\\?\\pipe\\discord-ipc-9');
});

test('linux candidates cover runtime dir, temp dirs, flatpak and snap', () => {
  const linux = pipeCandidates({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '', TMP: '' } });
  assert.equal(linux[0], '/run/user/1000/discord-ipc-0');
  assert.equal(linux[linux.length - 1], '/tmp/snap.discord/discord-ipc-9');
  assert.ok(linux.includes('/tmp/discord-ipc-0'));
  assert.ok(linux.includes('/run/user/1000/app/com.discordapp.Discord/discord-ipc-0'));
  assert.ok(linux.includes('/tmp/snap.discord/discord-ipc-9'));
  assert.equal(linux.length, 60);
  const temp = pipeCandidates({ platform: 'linux', env: { XDG_RUNTIME_DIR: '', TMPDIR: '/var/tmp/x', TMP: '/t' } });
  assert.equal(temp[0], '/var/tmp/x/discord-ipc-0');
  assert.ok(temp.includes('/t/discord-ipc-9'));
});

test('start walks pipes, handshakes on the first connect and waits for READY', async () => {
  const h = harness();
  h.client.start();
  await settle();
  assert.equal(h.paths.length, 1);
  assert.equal(h.paths[0], pipeCandidates()[0]);
  const socket = h.sockets[0];
  assert.equal(h.client.state().status, 'connecting');
  assert.deepEqual(socket.frames()[0], {
    op: OP.HANDSHAKE,
    json: { v: 1, client_id: 'test-client' },
    raw: '{"v":1,"client_id":"test-client"}',
  });
  assert.equal(socket.frames().length, 1);
  h.client.start();
  assert.equal(h.paths.length, 1);
  socket.receive(encodeFrame(OP.FRAME, { evt: 'READY' }));
  await settle();
  assert.equal(h.client.state().status, 'ready');
  assert.equal(h.client.state().pipe, h.paths[0]);
  assert.equal(h.client.state().attempts, 1);
});

test('refused candidates are tried once, then the walk moves on', async () => {
  const h = harness({ refuse: 2 });
  h.client.start();
  await settle();
  assert.equal(h.paths.length, 3);
  assert.equal(h.client.state().attempts, 3);
  assert.equal(h.client.state().pipe, h.paths[2]);
  assert.equal(h.client.state().status, 'connecting');
  assert.equal(h.client.state().lastError.message, 'ECONNREFUSED ' + h.paths[1]);
});

test('a socket error also moves the walk on', async () => {
  const h = harness({ errorFirst: true });
  h.client.start();
  await settle();
  assert.equal(h.client.state().status, 'connecting');
  assert.equal(h.sockets.length, 2);
  assert.equal(h.client.state().pipe, h.paths[1]);
});

test('an ERROR event stops the walk, records the message and backs off', async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0];
  socket.receive(encodeFrame(OP.FRAME, { evt: 'ERROR', message: 'Invalid client id' }));
  await settle();
  assert.equal(h.client.state().status, 'backoff');
  assert.equal(h.client.state().lastError.message, 'Invalid client id');
  assert.equal(h.paths.length, 1);
  assert.equal(socket.frames().length, 1);
  assert.deepEqual(h.timers.delays(), [1000]);
});

test('the live 51-byte CLOSE frame surfaces code and message and stops for good', async () => {
  assert.equal(CLOSE_INVALID_CLIENT_ID.length, 51);
  assert.equal(CLOSE_INVALID_CLIENT_ID.readUInt32LE(0), OP.CLOSE);
  assert.equal(CLOSE_INVALID_CLIENT_ID.readUInt32LE(4), 43);
  const decoded = createDecoder().push(CLOSE_INVALID_CLIENT_ID);
  assert.equal(decoded.length, 1);
  assert.deepEqual(decoded[0].json, { code: 4000, message: 'Invalid Client ID' });

  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0];
  socket.receive(CLOSE_INVALID_CLIENT_ID);
  await settle();
  const state = h.client.state();
  assert.equal(state.status, 'refused');
  assert.deepEqual(state.lastError, { code: 4000, message: 'Invalid Client ID' });
  assert.equal(h.timers.count(), 0);
  assert.equal(h.paths.length, 1);
  assert.equal(socket.frames().length, 1);
  h.timers.fireAll();
  await settle();
  assert.equal(h.client.state().status, 'refused');
  assert.equal(h.client.state().reconnects, 0);
});

test('the other configuration close codes are terminal too', async () => {
  for (const code of [4001, 4002, 4003, 4004]) {
    const h = harness();
    h.client.start();
    await settle();
    h.sockets[0].receive(encodeFrame(OP.CLOSE, { code, message: 'bad ' + code }));
    await settle();
    assert.equal(h.client.state().status, 'refused', code);
    assert.deepEqual(h.client.state().lastError, { code, message: 'bad ' + code });
    assert.equal(h.timers.count(), 0);
  }
});

test('4005 CLOSE still backs off and keeps Discord code and message', async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.sockets[0].receive(encodeFrame(OP.CLOSE, { code: 4005, message: 'Rate limited' }));
  await settle();
  assert.equal(h.client.state().status, 'backoff');
  assert.deepEqual(h.client.state().lastError, { code: 4005, message: 'Rate limited' });
  assert.deepEqual(h.timers.delays(), [1000]);
});

test('a CLOSE with no body keeps the generic close text and backs off', async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.sockets[0].receive(encodeFrame(OP.CLOSE, ''));
  await settle();
  assert.equal(h.client.state().status, 'backoff');
  assert.equal(h.client.state().lastError.message, 'discord closed the pipe');
  assert.equal(h.client.state().lastError.code, undefined);
  assert.deepEqual(h.timers.delays(), [1000]);
});

test('a CLOSE body with only a message keeps just the message', async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.sockets[0].receive(encodeFrame(OP.CLOSE, { message: 'gone away' }));
  await settle();
  assert.equal(h.client.state().status, 'backoff');
  assert.deepEqual(h.client.state().lastError, { message: 'gone away' });
});

test('start() after a refusal clears it and retries from the first pipe', async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.sockets[0].receive(CLOSE_INVALID_CLIENT_ID);
  await settle();
  assert.equal(h.client.state().status, 'refused');
  h.client.start();
  await settle();
  const state = h.client.state();
  assert.equal(state.status, 'connecting');
  assert.equal(state.lastError, null);
  assert.equal(state.attempts, 1);
  assert.equal(h.paths.length, 2);
  assert.equal(h.paths[1], h.paths[0]);
  assert.equal(h.sockets[1].frames()[0].op, OP.HANDSHAKE);
  assert.equal(h.timers.count(), 0);
});

test('an inbound PING gets a PONG echoing the same payload bytes', async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0];
  const pingRaw = '{"nonce":"ping-1"}';
  socket.receive(encodeFrame(OP.PING, pingRaw));
  await settle();
  const frames = socket.frames();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].op, OP.PONG);
  assert.equal(frames[1].raw, pingRaw);
});

test('activity set before READY coalesces to the last value only', async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0];
  h.client.setActivity({ details: 'first' });
  h.client.setActivity({ details: 'second' });
  h.client.setActivity({ details: 'third' });
  assert.equal(socket.frames().length, 1);
  socket.receive(encodeFrame(OP.FRAME, { evt: 'READY' }));
  await settle();
  const frames = socket.frames();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].op, OP.FRAME);
  assert.deepEqual(JSON.parse(frames[1].raw), {
    cmd: 'SET_ACTIVITY',
    nonce: '1000',
    args: { pid: 4242, activity: { details: 'third' } },
  });
});

test('a clear before READY coalesces to the clear form on the wire', async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0];
  h.client.setActivity({ details: 'stale' });
  h.client.clearActivity();
  assert.equal(socket.frames().length, 1);
  socket.receive(encodeFrame(OP.FRAME, { evt: 'READY' }));
  await settle();
  const frames = socket.frames();
  assert.equal(frames.length, 2);
  assert.deepEqual(JSON.parse(frames[1].raw), {
    cmd: 'SET_ACTIVITY',
    nonce: '1000',
    args: { pid: 4242 },
  });
});

test('activity set after READY is published at once', async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0];
  socket.receive(encodeFrame(OP.FRAME, { evt: 'READY' }));
  await settle();
  h.client.setActivity({ details: 'live' });
  const frames = socket.frames();
  assert.equal(frames.length, 2);
  assert.deepEqual(JSON.parse(frames[1].raw).args.activity, { details: 'live' });
});

test('a socket close leads to backoff and then a reconnect', async () => {
  const h = harness();
  h.client.start();
  await settle();
  h.sockets[0].receive(encodeFrame(OP.FRAME, { evt: 'READY' }));
  await settle();
  h.sockets[0].emit('close');
  await settle();
  assert.equal(h.client.state().status, 'backoff');
  assert.deepEqual(h.timers.delays(), [1000]);
  h.timers.fireAll();
  await settle();
  assert.equal(h.client.state().status, 'connecting');
  assert.equal(h.sockets.length, 2);
  assert.equal(h.client.state().reconnects, 1);
});

test('backoff doubles per failure and is capped at 30 seconds', async () => {
  const h = harness({ refuse: 1000 });
  h.client.start();
  await settle();
  const seen = [];
  for (let i = 0; i < 8; i++) {
    seen.push(h.timers.delays()[0]);
    h.timers.fireAll();
    await settle();
  }
  assert.deepEqual(seen, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('backoff doubles per failure and resets after READY', async () => {
  const h = harness();
  h.setRefuse(1000);
  h.client.start();
  await settle();
  assert.equal(h.client.state().status, 'backoff');
  assert.deepEqual(h.timers.delays(), [1000]);
  h.timers.fireAll();
  await settle();
  assert.equal(h.client.state().status, 'backoff');
  assert.deepEqual(h.timers.delays(), [2000]);
  h.setRefuse(0);
  h.timers.fireAll();
  await settle();
  const socket = h.sockets[h.sockets.length - 1];
  assert.equal(h.client.state().status, 'connecting');
  socket.receive(encodeFrame(OP.FRAME, { evt: 'READY' }));
  await settle();
  assert.equal(h.client.state().status, 'ready');
  socket.emit('close');
  await settle();
  assert.deepEqual(h.timers.delays(), [1000]);
});

test('stop cancels the reconnect and is idempotent', async () => {
  const h = harness({ refuse: 1000 });
  h.client.start();
  await settle();
  assert.equal(h.client.state().status, 'backoff');
  assert.equal(h.timers.count(), 1);
  const first = h.client.stop();
  const second = h.client.stop();
  assert.equal(first, second);
  assert.equal(h.client.state().status, 'stopped');
  assert.equal(h.timers.count(), 0);
  h.timers.fireAll();
  await settle();
  assert.equal(h.client.state().status, 'stopped');
  await first;
  await second;
});

test('stop closes the active socket and resolves once it is closed', async () => {
  const h = harness();
  h.client.start();
  await settle();
  const socket = h.sockets[0];
  const done = h.client.stop();
  await done;
  assert.equal(h.client.state().status, 'stopped');
  assert.equal(socket.destroyed, true);
});

test('a throwing logger or clock never escapes a public call', async () => {
  const h = harness({ refuse: 1000, log: () => { throw new Error('bad logger'); } });
  assert.doesNotThrow(() => h.client.start());
  await settle();
  assert.doesNotThrow(() => h.client.setActivity({ details: 'x' }));
  assert.doesNotThrow(() => h.client.clearActivity());
  assert.equal(h.client.state().status, 'backoff');
  const brokenClock = harness({ now: () => { throw new Error('bad clock'); } });
  brokenClock.client.start();
  await settle();
  brokenClock.sockets[0].receive(encodeFrame(OP.FRAME, { evt: 'READY' }));
  await settle();
  assert.doesNotThrow(() => brokenClock.client.setActivity({ details: 'x' }));
});
