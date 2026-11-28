// The wire layer of oc-discord-rpc: the frame codec, pipe discovery and the
// client that owns one local IPC socket.
//
// This module stops at the wire. It knows nothing about what an activity means
// and never owns the clock: payload shaping and timing are injected so the
// protocol can be exercised without a Discord process. Discord not running is
// the ordinary case, so no callback throws. A failure is recorded in state()
// and the client either walks to the next pipe, waits before trying again, or
// stops for good when Discord rejects the handshake configuration itself.
// Only Node's built-in net and stream primitives are permitted here; this file
// needs just net for the production dial. No third-party dependencies.
import net from 'node:net';

/**
 * @typedef {{op: number, json: object|null, raw: string}} DecodedFrame
 * @typedef {{status: 'stopped'|'connecting'|'ready'|'backoff'|'refused', pipe: string, attempts: number, reconnects: number, sent: number, lastError: {code?: number, message: string}|null}} ClientState
 * @typedef {(path: string) => any} Connector
 */

const HEADER_BYTES = 8;
const MAX_PAYLOAD = 1024 * 1024;
const PIPE_SLOTS = 10;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 30000;
// A pending clear is a real value. A sentinel is the only way to tell it apart
// from "nobody asked for anything yet".
const NO_PENDING = Symbol('no pending activity');
// 'refused' is terminal for one start(): Discord closed with a code retrying
// cannot fix. It is not a deliberate stop(), and a later start() clears it.
const TERMINAL_CLOSE_CODES = Object.freeze([4000, 4001, 4002, 4003, 4004]);

export const OP = Object.freeze({ HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 });

// A malformed object must not take down a socket callback on its way to the wire.
function payloadText(payload) {
  if (typeof payload === 'string') return payload;
  if (payload === undefined || payload === null) return '';
  try {
    const text = JSON.stringify(payload);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * One frame on the pipe: uint32 opcode, uint32 payload byte length, then UTF-8.
 * Both header fields are little-endian because that is what the pipe expects.
 * @param {number} op
 * @param {string|object} payload
 * @returns {Buffer}
 */
export function encodeFrame(op, payload) {
  const bytes = Buffer.from(payloadText(payload), 'utf8');
  const frame = Buffer.allocUnsafe(HEADER_BYTES + bytes.length);
  frame.writeUInt32LE(op >>> 0, 0);
  frame.writeUInt32LE(bytes.length, 4);
  bytes.copy(frame, HEADER_BYTES);
  return frame;
}

/**
 * Incremental decoder. It keeps the tail of a partial frame between pushes, so
 * a frame split across any number of chunks and several frames in one chunk
 * both come out as the same list of whole frames.
 * @returns {{push: (chunk: Buffer) => DecodedFrame[]}}
 */
export function createDecoder() {
  let buffered = Buffer.alloc(0);
  return {
    push(chunk) {
      const add = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk == null ? '' : String(chunk), 'utf8');
      buffered = buffered.length ? Buffer.concat([buffered, add]) : add;
      const frames = [];
      let at = 0;
      while (buffered.length - at >= HEADER_BYTES) {
        const op = buffered.readUInt32LE(at);
        const length = buffered.readUInt32LE(at + 4);
        // A bad length is refused before any allocation: a corrupt header must
        // never be able to make us reserve arbitrary memory.
        if (length > MAX_PAYLOAD) throw new Error('frame payload length ' + length + ' exceeds the 1 MiB limit');
        const total = HEADER_BYTES + length;
        if (buffered.length - at < total) break;
        const raw = buffered.toString('utf8', at + HEADER_BYTES, at + total);
        // An unparseable payload is still returned with its raw text, so a
        // caller can log what Discord sent instead of dying on it.
        let json = null;
        if (raw.trim()) {
          try { json = JSON.parse(raw); } catch { json = null; }
        }
        frames.push({ op, json, raw });
        at += total;
      }
      if (at > 0) buffered = buffered.subarray(at);
      return frames;
    },
  };
}

/**
 * @param {string} clientId
 * @returns {{v: number, client_id: string}}
 */
export function handshakePayload(clientId) {
  return { v: 1, client_id: clientId == null ? '' : String(clientId) };
}

/**
 * The nonce is supplied by the caller; time belongs to the client, not here.
 * The clear form leaves the activity key out entirely rather than sending null,
 * because that is the shape Discord treats as "clear presence".
 * @param {{pid: number, nonce: string, activity?: object|null}} parts
 * @returns {string}
 */
export function setActivityPayload({ pid, nonce, activity }) {
  const args = activity === undefined || activity === null ? { pid } : { pid, activity };
  return JSON.stringify({ cmd: 'SET_ACTIVITY', nonce: nonce == null ? '' : String(nonce), args });
}

function joinPath(base, leaf) {
  let root = String(base);
  while (root.endsWith('/')) root = root.slice(0, -1);
  return root + '/' + leaf;
}

/**
 * Windows uses the NT pipe namespace Node documents; elsewhere every known
 * Discord socket directory is offered, each with all ten client slots. The
 * order is fixed so a caller can retry deterministically and stop at the first
 * pipe that answers.
 * @param {{platform?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {string[]}
 */
export function pipeCandidates({ platform = process.platform, env = process.env } = {}) {
  const out = [];
  if (platform === 'win32') {
    const prefix = '\\\\?\\pipe\\discord-ipc-';
    for (let i = 0; i < PIPE_SLOTS; i++) out.push(prefix + i);
    return out;
  }
  const roots = [];
  for (const base of [env && env.XDG_RUNTIME_DIR, env && env.TMPDIR, env && env.TMP, '/tmp']) {
    if (typeof base === 'string' && base && !roots.includes(base)) roots.push(base);
  }
  const prefixes = [];
  for (const root of roots) {
    prefixes.push(root);
    prefixes.push(joinPath(root, 'app/com.discordapp.Discord'));
    prefixes.push(joinPath(root, 'snap.discord'));
  }
  for (const prefix of prefixes) {
    for (let i = 0; i < PIPE_SLOTS; i++) out.push(joinPath(prefix, 'discord-ipc-' + i));
  }
  return out;
}

function errorMessage(value) {
  if (value && typeof value === 'object') {
    if (typeof value.message === 'string' && value.message) return value.message;
    if (value.data && typeof value.data.message === 'string' && value.data.message) return value.data.message;
    if (typeof value.evt === 'string' && value.evt) return value.evt;
  }
  return value === undefined || value === null ? '' : String(value);
}

// Discord rejects a handshake with a CLOSE frame rather than an ERROR event.
// The body is the only place its own reason appears, so keep it verbatim: for
// a wrong app id that sentence is the most useful thing in the whole failure
// path. A code with no message still keeps the code; no body at all is left to
// the caller's generic close text.
function closeError(frame) {
  const body = frame && frame.json && typeof frame.json === 'object' ? frame.json : null;
  if (!body || (body.code === undefined && typeof body.message !== 'string')) return null;
  const message = typeof body.message === 'string' ? body.message : '';
  return body.code === undefined ? { message } : { code: body.code, message };
}

// 4000-4004 describe a handshake or configuration fault: the same CLOSE comes
// back on every retry. 4005 (rate limited) and every other code describe a
// momentary condition, so they keep the normal backoff.
function isTerminalRefusal(code) {
  const value = Number(code);
  return Number.isInteger(value) && TERMINAL_CLOSE_CODES.includes(value);
}

/**
 * A single-owner client for the local Discord IPC socket. The connect, clock,
 * logger and timer seams are injected so a test can use a fake duplex and fire
 * timers by hand; production gets net.connect and the real globals.
 * @param {{clientId?: string, pid?: number, connect?: Connector, now?: () => number, log?: (...args: any[]) => void, minIntervalMs?: number, setTimeout?: (fn: () => void, ms: number) => any, clearTimeout?: (id: any) => void}} [options]
 * @returns {{start: () => void, stop: () => Promise<void>, setActivity: (activity: any) => void, clearActivity: () => void, state: () => ClientState}}
 */
export function createClient({
  clientId,
  pid,
  connect = (target) => net.connect(target),
  now = Date.now,
  log = () => {},
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  setTimeout: schedule = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
  const paths = pipeCandidates();
  const givenMin = Number(minIntervalMs);
  const min = Math.min(Math.max(givenMin > 0 ? givenMin : DEFAULT_MIN_INTERVAL_MS, 1), MAX_INTERVAL_MS);

  let status = 'stopped';
  let pipe = '';
  let attempts = 0;
  let reconnects = 0;
  let sent = 0;
  let lastError = null;
  let pending = NO_PENDING;
  let active = null;
  let timer = null;
  let index = 0;
  let delay = min;
  let halt = false;
  let stopped = false;
  let backoffPending = false;
  let stopPromise = null;
  let currentFail = () => {};
  let currentAbort = () => {};

  function safeLog(...args) {
    try { log(...args); } catch { /* a broken logger must never break the wire */ }
  }

  function noteError(value) {
    const message = errorMessage(value) || 'unknown error';
    lastError = { message };
    safeLog('discord rpc:', message);
  }

  function abortActive() {
    const socket = active;
    active = null;
    currentFail = () => {};
    currentAbort = () => {};
    if (!socket) return;
    try { socket.destroy(); } catch { /* an already-closed pipe needs no help */ }
  }

  function send(socket, op, payload) {
    try {
      socket.write(encodeFrame(op, payload));
      sent++;
      return null;
    } catch (err) {
      noteError(err);
      return err;
    }
  }

  function publish(socket, activity) {
    try {
      return send(socket, OP.FRAME, setActivityPayload({ pid, nonce: String(now()), activity }));
    } catch (err) {
      noteError(err);
      return err;
    }
  }

  function enterBackoff() {
    if (stopped || status === 'refused' || backoffPending) return;
    backoffPending = true;
    halt = true;
    status = 'backoff';
    const wait = delay;
    // Double after a failure, but cap so a long outage cannot grow the wait
    // without bound. READY puts it back to the minimum.
    delay = Math.min(delay * 2, MAX_INTERVAL_MS);
    reconnects++;
    try {
      timer = schedule(() => {
        timer = null;
        backoffPending = false;
        if (stopped) return;
        beginWalk();
      }, wait);
    } catch (err) {
      noteError(err);
      backoffPending = false;
      status = 'stopped';
    }
  }

  function handleFrame(frame, socket, fail) {
    if (frame.op === OP.PING) {
      // Echo the payload bytes unchanged; Discord uses them to time us out.
      const err = send(socket, OP.PONG, frame.raw);
      if (err) fail(err);
      return;
    }
    if (frame.op === OP.CLOSE) {
      halt = true;
      const error = closeError(frame);
      if (error && isTerminalRefusal(error.code)) {
        // Retrying a configuration fault only hammers the user's Discord. Stop
        // with its own reason and no timer; a later start() clears the refusal
        // so a corrected app id gets a fresh attempt.
        lastError = error;
        safeLog('discord rpc: refused on', pipe, error.code, error.message);
        status = 'refused';
        currentAbort();
        return;
      }
      if (error) {
        // Already noted from the body: fail() must not replace it with generic
        // close text (the alreadyNoted flag below).
        lastError = error;
        safeLog('discord rpc: close', error.code, error.message);
        fail(new Error(error.message || 'discord closed the pipe'), true);
      } else {
        fail(new Error('discord closed the pipe'));
      }
      return;
    }
    if (frame.op === OP.PONG) return;
    if (frame.op !== OP.FRAME || !frame.json || typeof frame.json !== 'object') return;
    if (frame.json.evt === 'READY') {
      delay = min;
      status = 'ready';
      halt = true;
      safeLog('discord rpc: ready on', pipe);
      // Presence is state, not a queue: only the newest pending value is sent.
      if (pending !== NO_PENDING) {
        const activity = pending;
        pending = NO_PENDING;
        const err = publish(socket, activity);
        if (err) fail(err);
      }
      return;
    }
    if (frame.json.evt === 'ERROR') {
      noteError(frame.json);
      // A rejected handshake will be rejected on every remaining pipe too, so
      // stop the walk here rather than hammering the other nine slots.
      halt = true;
      fail(frame.json);
    }
  }

  function walk() {
    if (stopped || halt || index >= paths.length) {
      if (!stopped && index >= paths.length && !halt) enterBackoff();
      return;
    }
    const target = paths[index++];
    attempts++;
    const decoder = createDecoder();
    let socket;
    try {
      socket = connect(target);
    } catch (err) {
      noteError(err);
      walk();
      return;
    }
    if (!socket || typeof socket.on !== 'function' || typeof socket.write !== 'function') {
      noteError(new Error('connect returned no usable socket'));
      walk();
      return;
    }
    active = socket;
    let done = false;

    function fail(err, alreadyNoted = false) {
      if (done) return;
      done = true;
      if (!alreadyNoted) noteError(err);
      abortActive();
      if (stopped) return;
      // While still walking, a refused candidate is routine. Once a pipe was
      // ready (or the walk was halted), the same event is a lost connection.
      if (status === 'connecting' && !halt) walk();
      else enterBackoff();
    }
    currentFail = fail;

    // Close without scheduling a retry: the terminal refusal path must forget
    // this attempt but never arm a backoff timer.
    function stopAttempt() {
      if (done) return;
      done = true;
      abortActive();
    }
    currentAbort = stopAttempt;

    function onConnect() {
      try {
        if (done || stopped || halt) return;
        pipe = target;
        const err = send(socket, OP.HANDSHAKE, handshakePayload(clientId));
        if (err) fail(err);
      } catch (err) { noteError(err); }
    }
    function onData(chunk) {
      try {
        if (done || stopped) return;
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          if (done) break;
          handleFrame(frame, socket, fail);
        }
      } catch (err) { noteError(err); }
    }
    function onError(err) { fail(err || new Error('socket error')); }
    function onClose() { fail(new Error('socket closed')); }

    try {
      socket.on('connect', onConnect);
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    } catch (err) {
      fail(err);
    }
  }

  function beginWalk() {
    if (stopped) return;
    halt = false;
    backoffPending = false;
    index = 0;
    pipe = '';
    status = 'connecting';
    walk();
  }

  return {
    start() {
      try {
        // A refusal is terminal only for this attempt. The user may have fixed
        // the app id, so start() clears it and walks from the first pipe again.
        if (status !== 'stopped' && status !== 'refused') return;
        stopped = false;
        halt = false;
        backoffPending = false;
        attempts = 0;
        reconnects = 0;
        lastError = null;
        delay = min;
        stopPromise = null;
        beginWalk();
      } catch (err) { noteError(err); }
    },

    stop() {
      try {
        stopped = true;
        halt = true;
        if (timer !== null) {
          try { cancel(timer); } catch { /* a cancelled timer is still cancelled */ }
          timer = null;
        }
        status = 'stopped';
        const socket = active;
        active = null;
        currentFail = () => {};
        currentAbort = () => {};
        if (!socket) {
          if (!stopPromise) stopPromise = Promise.resolve();
          return stopPromise;
        }
        if (!stopPromise) {
          stopPromise = new Promise((resolve) => {
            let resolved = false;
            function done() {
              if (resolved) return;
              resolved = true;
              try { socket.removeListener('close', done); } catch { /* ignore */ }
              resolve();
            }
            try { socket.once('close', done); } catch { done(); return; }
            if (socket.destroyed || socket.closed) done();
            else {
              try { socket.destroy(); } catch { done(); }
            }
          });
        }
        return stopPromise;
      } catch (err) {
        noteError(err);
        return Promise.resolve();
      }
    },

    setActivity(activity) {
      try {
        if (status === 'ready' && active) {
          const err = publish(active, activity);
          if (err) currentFail(err);
          return;
        }
        pending = activity;
      } catch (err) { noteError(err); }
    },

    clearActivity() {
      try { this.setActivity(null); } catch (err) { noteError(err); }
    },

    state() {
      return {
        status,
        pipe,
        attempts,
        reconnects,
        sent,
        // Copy the whole detail: a CLOSE body carries Discord's code as well
        // as its sentence, and both belong in the snapshot.
        lastError: lastError ? { ...lastError } : null,
      };
    },
  };
}
