import { createSocket } from "node:dgram";
import { request as httpRequest, Agent as HttpAgent, createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { networkInterfaces, hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pbkdf2 as cryptoPbkdf2, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();
const APP_ID = "oc-phone-link";
const PORT_BASE = Number(process.env.OC_PHONE_LINK_PORT_BASE || 0);
const BIND_HOST = process.env.OC_PHONE_LINK_BIND_HOST || "0.0.0.0";
const NO_UDP = process.env.OC_PHONE_LINK_NO_UDP === "1";
const p_ = (n) => (PORT_BASE ? PORT_BASE + (n - 41337) : n);
const UDP_PORT = p_(41337);
const HTTPS_PORT = p_(41338);
const PROXY_PORT = p_(41340);
const LOOPBACK_PORT = p_(41339);
const EXPOSED_PORT = p_(41341);
const OPENCODE_PORT = 28894;
const PROBE = "OC_PHONE_LINK/1";
const STATE_VERSION = 5;
const DEVICE_ID_MAX = 128;
const NAME_MAX = 128;
const REQ_WINDOW_MS = 60 * 1000;
const REQ_MAX = 10;
const BODY_CAP = 4096;
const LOG_MAX = 5 * 1024 * 1024;
const KEY_TTL = 90 * 24 * 60 * 60 * 1000;
const KEY_ROTATE_AFTER = 45 * 24 * 60 * 60 * 1000;
const KEY_COOKIE_MAX_AGE = 90 * 24 * 60 * 60;
const KEY_PERSIST_MS = 60 * 1000;
const KEY_CAP = 16;
const UPSTREAM_TIMEOUT_MS = 5000;
const UPSTREAM_PROBE_MS = 400;
const PIN_ITER = 600000;
const DERIVE_MAX = 2;
const PASSWORD_NEG_TTL = 30000;
const reqHits = new Map(); // ip -> [ts...] sliding window
let now = () => Date.now();

const AUTH_FAIL_MAX = 5;
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAP_MAX = 1024;
const authFails = new Map(); // ip -> { count, first, until }

function authBlocked(ip) {
  const e = authFails.get(ip);
  if (!e) return 0;
  const t = now();
  if (e.until) {
    if (t < e.until) return Math.max(1, Math.ceil((e.until - t) / 1000));
    authFails.delete(ip);
    return 0;
  }
  if (t - e.first >= AUTH_WINDOW_MS) { authFails.delete(ip); return 0; }
  return 0;
}

function noteAuthFail(ip) {
  const t = now();
  let e = authFails.get(ip);
  if (!e || (t - e.first >= AUTH_WINDOW_MS && !e.until)) e = { count: 0, first: t, until: 0 };
  e.count += 1;
  if (e.count >= AUTH_FAIL_MAX) e.until = t + AUTH_WINDOW_MS;
  authFails.set(ip, e);
  if (authFails.size > AUTH_MAP_MAX) {
    for (const [key, val] of authFails) if (t - val.first >= AUTH_WINDOW_MS) authFails.delete(key);
    if (authFails.size > AUTH_MAP_MAX) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, val] of authFails) {
        const age = val.until || val.first;
        if (age < oldest) { oldest = age; oldestKey = key; }
      }
      if (oldestKey !== null) authFails.delete(oldestKey);
    }
  }
  return e.count === AUTH_FAIL_MAX;
}

function beginGuess(ip) {
  const t = now();
  let e = authFails.get(ip);
  if (e && e.until) {
    if (t < e.until) return false;
    authFails.delete(ip);
    e = null;
  }
  if (!e || t - e.first >= AUTH_WINDOW_MS) e = { count: 0, first: t, until: 0 };
  e.count += 1;
  if (e.count >= AUTH_FAIL_MAX) e.until = t + AUTH_WINDOW_MS;
  authFails.set(ip, e);
  if (authFails.size > AUTH_MAP_MAX) {
    for (const [key, val] of authFails) if (t - val.first >= AUTH_WINDOW_MS) authFails.delete(key);
    if (authFails.size > AUTH_MAP_MAX) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, val] of authFails) {
        const age = val.until || val.first;
        if (age < oldest) { oldest = age; oldestKey = key; }
      }
      if (oldestKey !== null) authFails.delete(oldestKey);
    }
  }
  return true;
}

const noteAuthOk = (ip) => authFails.delete(ip);

const AUTH_INFLIGHT_MAX = 6;
const AUTH_INFLIGHT_TOTAL = 32;
const AUTH_BODY_TIMEOUT_MS = 5000;
let authInFlight = 0;
const authInFlightByIp = new Map(); // ip -> count

function authEnter(ip) {
  const n = authInFlightByIp.get(ip) || 0;
  if (authInFlight >= AUTH_INFLIGHT_TOTAL || n >= AUTH_INFLIGHT_MAX) return false;
  authInFlight += 1;
  authInFlightByIp.set(ip, n + 1);
  return true;
}

function authLeave(ip) {
  const n = authInFlightByIp.get(ip) || 0;
  if (n <= 1) authInFlightByIp.delete(ip);
  else authInFlightByIp.set(ip, n - 1);
  authInFlight = Math.max(0, authInFlight - 1);
}

const setupRefused = new Map(); // ip -> last log time
function logSetupRefused(ip) {
  const t = now();
  if (t - (setupRefused.get(ip) || 0) < 60 * 1000) return;
  setupRefused.set(ip, t);
  if (setupRefused.size > 256) {
    for (const [key, ts] of setupRefused) if (t - ts >= 60 * 1000) setupRefused.delete(key);
    if (setupRefused.size > 256) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [key, ts] of setupRefused) {
        if (ts < oldest) { oldest = ts; oldestKey = key; }
      }
      if (oldestKey !== null) setupRefused.delete(oldestKey);
    }
  }
  log("setup refused", ip, "owner must set the PIN on the PC");
}

function throttled(ip) {
  const t = Date.now();
  const arr = (reqHits.get(ip) || []).filter((x) => t - x < REQ_WINDOW_MS);
  if (arr.length >= REQ_MAX) { reqHits.set(ip, arr); return true; }
  arr.push(t);
  reqHits.set(ip, arr);
  return false;
}

const DATA_DIR = process.env.OC_PHONE_LINK_DATA_DIR ||
  join(process.env.LOCALAPPDATA || process.cwd(), "OCPhoneLink");
const LOG = join(DATA_DIR, "agent.log");
const STATE = join(DATA_DIR, "state.json");
const TLS_DIR = join(DATA_DIR, "tls");

let state = null;

function log(...a) {
  const line = new Date().toISOString() + " " + a.join(" ").replace(/[\r\n]+/g, " ");
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    if (existsSync(LOG) && statSync(LOG).size > LOG_MAX) renameSync(LOG, LOG + ".1");
    appendFileSync(LOG, line + "\n");
  } catch {}
}

const isHex = (s, bytes) => typeof s === "string" && s.length === bytes * 2 && /^[0-9a-f]+$/i.test(s);
const validPin = (p) => !!p && typeof p === "object" && isHex(p.salt, 16) && isHex(p.hash, 32);
const pinPattern = /^\d{8}$/;
const validPinClaim = (c) => !!c && typeof c === "object" &&
  typeof c.ip === "string" && c.ip.length > 0 &&
  (typeof c.name === "string" || c.name === null) && Number.isFinite(c.at);
const blankState = () => ({ v: STATE_VERSION, pin: null, pinClaim: null,
  keys: [], owner: randomBytes(16).toString("hex") });

// Only the owner's own networks may claim the first PIN. A mapped IPv4 address
// is tested as the IPv4 it carries; anything unparseable is refused.
function isPrivatePeer(value) {
  let ip = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (mapped) ip = mapped[1];
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return false;
    const [a, b] = parts;
    return a === 10 || a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254);
  }
  if (ip === "::1") return true;
  const head = /^([0-9a-f]{1,4})(?::|$)/.exec(ip);
  if (!head) return false;
  const n = parseInt(head[1], 16);
  return (n & 0xfe00) === 0xfc00 || (n & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
}
state = blankState();

const keyHash = (k) => (typeof k === "string" ? k : k && k.h);
const validKey = (k) => isHex(keyHash(k), 32) &&
  (typeof k === "string" ||
    (k && typeof k === "object" && Number.isFinite(k.issued) && Number.isFinite(k.lastUsed)));
const normalizeKey = (k) => (typeof k === "string"
  ? { h: k.toLowerCase(), issued: now(), lastUsed: now(), lastIp: null, device: null, name: null }
  : { h: String(k.h).toLowerCase(), issued: k.issued, lastUsed: k.lastUsed,
      lastIp: typeof k.lastIp === "string" ? k.lastIp : null,
      device: typeof k.device === "string" ? k.device : null,
      name: typeof k.name === "string" ? k.name : null });

function loadState() {
  let raw;
  try { raw = readFileSync(STATE, "utf8"); }
  catch (e) {
    if (e.code !== "ENOENT") {
      return { ok: false, error: "state read failed: " + (e.code || e.message) };
    }
    const fresh = blankState();
    if (!saveState(fresh)) return { ok: false, error: "state create failed" };
    log("state created");
    return { ok: true, state: fresh };
  }

  let s;
  try { s = JSON.parse(raw); }
  catch (e) { return { ok: false, error: "state parse failed: " + e.message }; }
  if (!s || typeof s !== "object" || Array.isArray(s)) {
    return { ok: false, error: "state is not an object" };
  }

  // Any pre-v5 state is discarded wholesale: its PIN may be shorter than 8
  // digits and its key set may mix untagged keys with plaintext legacy tokens.
  // A fresh, fail-closed state is the only safe migration target.
  if (s.v !== STATE_VERSION) {
    const fresh = blankState();
    log("state migrated: PIN and keys cleared; set an 8-digit PIN on the PC, then pair the phone again");
    if (!saveState(fresh)) return { ok: false, error: "state migration not persisted" };
    return { ok: true, state: fresh };
  }

  let changed = false;
  const pinPresent = s.pin !== undefined && s.pin !== null;
  if (s.pin === undefined) { s.pin = null; changed = true; }
  else if (s.pin !== null && !validPin(s.pin)) return { ok: false, error: "state pin is invalid" };
  if (s.keys === undefined) {
    if (pinPresent) return { ok: false, error: "state keys are missing" };
    s.keys = [];
    changed = true;
  } else if (!Array.isArray(s.keys) || !s.keys.every(validKey)) {
    return { ok: false, error: "state keys are invalid" };
  } else if (s.keys.some((k) => typeof k !== "object")) {
    s.keys = s.keys.map(normalizeKey);
    changed = true;
  }
  if (!pinPresent && s.keys.length > 0) return { ok: false, error: "state keys have no PIN" };

  const pruned = s.keys.filter((k) => now() - (k.lastUsed || 0) > KEY_TTL).length;
  if (pruned) {
    s.keys = s.keys.filter((k) => now() - (k.lastUsed || 0) <= KEY_TTL);
    changed = true;
  }

  if (!isHex(s.owner, 16)) {
    if (s.owner !== undefined && s.owner !== null) return { ok: false, error: "state owner is invalid" };
    s.owner = randomBytes(16).toString("hex");
    changed = true;
  }

  if ("devices" in s || "pending" in s) {
    delete s.devices;
    delete s.pending;
    changed = true;
  }
  if (s.pinClaim === undefined) { s.pinClaim = null; changed = true; }
  else if (s.pinClaim !== null && (!validPinClaim(s.pinClaim) || !pinPresent)) {
    s.pinClaim = null;
    changed = true;
  }

  if (changed) {
    if (pruned) log("state keys pruned", pruned);
    s.v = STATE_VERSION;
    if (!saveState(s)) log("state normalize not persisted");
  }
  return { ok: true, state: s };
}

function saveState(s) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE + ".tmp";
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, STATE);
    return true;
  } catch (e) { log("state save fail", e.message); return false; }
}

function stateAfterResetFlag(s, argv) {
  // The --reset flag is retired with the approval/device model. Keep the PIN,
  // every key and the owner token; only the version is normalised.
  if (!Array.isArray(argv) || !argv.includes("--reset")) return s;
  return { ...s, v: STATE_VERSION, pin: s.pin, pinClaim: s.pinClaim || null,
    keys: s.keys, owner: s.owner };
}

function hexEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (x.length !== y.length || x.length === 0) return false;
  try { return timingSafeEqual(Buffer.from(x), Buffer.from(y)); } catch { return false; }
}

let deriveActive = 0;
let derivePeak = 0;
let deriveTotal = 0;
const deriveQueue = [];

function deriveOnce(pin, saltHex) {
  return new Promise((resolve, reject) => {
    cryptoPbkdf2(String(pin), Buffer.from(saltHex, "hex"), PIN_ITER, 32, "sha256",
      (err, buf) => { if (err) reject(err); else resolve(buf); });
  });
}

function pumpDerive() {
  while (deriveActive < DERIVE_MAX && deriveQueue.length) {
    const job = deriveQueue.shift();
    deriveActive += 1;
    derivePeak = Math.max(derivePeak, deriveActive);
    deriveTotal += 1;
    deriveOnce(job.pin, job.salt)
      .then((buf) => job.resolve(buf), (err) => job.reject(err))
      .then(() => { deriveActive -= 1; pumpDerive(); });
  }
}

const pinHash = (pin, saltHex) => new Promise((resolve, reject) => {
  deriveQueue.push({ pin: pin, salt: saltHex, resolve: resolve, reject: reject });
  pumpDerive();
});

async function setPin(pin, opts) {
  const p = String(pin || "");
  if (!pinPattern.test(p)) return "pin-invalid";
  const before = state.pin;
  const beforeClaim = state.pinClaim;
  const beforeKeys = (state.keys || []).slice();
  const salt = randomBytes(16).toString("hex");
  const hash = (await pinHash(p, salt)).toString("hex");
  // Another request may have claimed the PIN while this derivation was queued.
  if (state.pin !== before) return "pin-exists";
  const t = Date.now();
  state.pin = { salt: salt, hash: hash, at: t };
  if (opts && opts.claim) state.pinClaim = { ip: opts.claim.ip, name: opts.claim.name, at: t };
  if (opts && opts.keyRecord) {
    if (!Array.isArray(state.keys)) state.keys = [];
    state.keys.push(opts.keyRecord);
    if (state.keys.length > KEY_CAP) state.keys = state.keys.slice(-KEY_CAP);
  }
  if (!saveState(state)) {
    state.pin = before;
    state.pinClaim = beforeClaim;
    state.keys = beforeKeys;
    log("pin set not persisted: rolled back");
    return "save-failed";
  }
  log("pin set");
  if (opts && opts.claim) log("pin set by phone", opts.claim.ip, opts.claim.name || "unknown");
  return null;
}

async function pinMatches(input) {
  if (!state.pin) return false;
  try {
    const got = await pinHash(input, state.pin.salt);
    const want = Buffer.from(state.pin.hash, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  } catch { return false; }
}

function suppliedKey(req) {
  try {
    const u = new URL(req.url || "/", "https://127.0.0.1");
    const q = u.searchParams.get("ocpl_key");
    if (q) return { key: q, viaQuery: true };
  } catch {}
  const cookie = String(req.headers.cookie || "");
  const c = cookie.match(/(?:^|;\s*)ocpl_key=([^;]*)/);
  if (c && c[1]) {
    try { return { key: decodeURIComponent(c[1]), viaQuery: false }; }
    catch { return { key: c[1], viaQuery: false }; }
  }
  const h = String(req.headers["x-ocpl-key"] || "");
  if (h) return { key: h, viaQuery: false };
  return null;
}

const ACTIVE_KEY = Symbol("ocpl.activeKey");
const ROTATED_KEY = Symbol("ocpl.rotatedKey");
const keyPersistAt = new WeakMap();

function keyRecord(hash) {
  const i = (state.keys || []).findIndex((k) => hexEq(keyHash(k), hash));
  if (i < 0) return null;
  let rec = state.keys[i];
  if (typeof rec === "string") { rec = normalizeKey(rec); state.keys[i] = rec; }
  return rec;
}

function activeKey(req) {
  const s = suppliedKey(req);
  if (!s) return null;
  const hash = sha256hex(s.key);
  const rec = keyRecord(hash);
  if (!rec) return null;
  if (now() - (rec.lastUsed || 0) > KEY_TTL) return null;
  return { key: s.key, viaQuery: s.viaQuery, hash: hash, rec: rec };
}

function touchKey(req, ak) {
  if (!ak) return;
  const t = now();
  ak.rec.lastIp = (req.socket && req.socket.remoteAddress) || null;
  if (!Number.isFinite(ak.rec.issued)) ak.rec.issued = t;
  ak.rec.lastUsed = t;
  let rotated = null;
  if (t - ak.rec.issued >= KEY_ROTATE_AFTER) {
    // An untagged key cannot be re-associated on revoke, so keep it valid and
    // reset its clock. A tagged key rotates into a tagged replacement.
    if (ak.rec.device) {
      const key = randomBytes(24).toString("hex");
      const hash = sha256hex(key);
      if (!keyRecord(hash)) {
        state.keys.push({ h: hash, issued: t, lastUsed: t, lastIp: ak.rec.lastIp,
          device: ak.rec.device, name: ak.rec.name || null });
        if (state.keys.length > KEY_CAP) state.keys = state.keys.slice(-KEY_CAP);
        rotated = key;
        log("device key rotated", ak.rec.lastIp || "?");
      }
    }
    ak.rec.issued = t;
  }
  if (rotated || t - (keyPersistAt.get(ak.rec) || 0) >= KEY_PERSIST_MS) {
    if (saveState(state)) keyPersistAt.set(ak.rec, t);
  }
  if (rotated) req[ROTATED_KEY] = rotated;
}

function keyOk(req) {
  const ak = activeKey(req);
  if (!ak) return false;
  req[ACTIVE_KEY] = ak;
  touchKey(req, ak);
  return true;
}

function ownerToken(req) {
  const cookie = String((req && req.headers && req.headers.cookie) || "");
  const m = cookie.match(/(?:^|;\s*)ocpl_owner=([^;]*)/);
  if (!m || !m[1]) return null;
  let token = m[1];
  try { token = decodeURIComponent(token); } catch {}
  return hexEq(token, state.owner) ? token : null;
}

// Gate: loopback is a source address, never an identity. No isLocal() here.
function gate(req, opts) {
  if (!state.pin || !state.pin.hash) return "setup";
  if (keyOk(req)) return null;
  if (opts && opts.owner && ownerToken(req)) return null;
  return "pin";
}

function revoke(hash) {
  const before = state.keys.slice();
  const targeted = typeof hash === "string" && hash.length > 0;
  if (targeted) state.keys = state.keys.filter((k) => !hexEq(keyHash(k), hash.toLowerCase()));
  else state.keys = [];
  const revoked = before.length - state.keys.length;
  if (!saveState(state)) {
    state.keys = before;
    log("revoke not persisted: rolled back");
    return { ok: false, revoked: 0, keys: before.length, saved: false };
  }
  log("revoke", targeted ? "key" : "all", "removed:", revoked, "left:", state.keys.length);
  return { ok: true, revoked: revoked, keys: state.keys.length, saved: true };
}

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (/^(vEthernet|Loopback|WSL|VirtualBox|VMware|Hyper-V)/i.test(name)) continue;
      out.push({ name: name, address: a.address, netmask: a.netmask });
    }
  }
  out.sort((x, y) => (x.address.startsWith("192.168.") ? -1 : 0) - (y.address.startsWith("192.168.") ? -1 : 0));
  return out;
}

function fingerprintOf(pemCert) {
  const body = pemCert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return createHash("sha256").update(Buffer.from(body, "base64")).digest("hex");
}

const shortFingerprint = (fp) => String(fp || "").slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ");

let tls = { cert: "", key: "", fingerprint: "", ips: [] };

function ensureCert() {
  try { mkdirSync(TLS_DIR, { recursive: true }); } catch {}
  const certPath = join(TLS_DIR, "cert.pem");
  const keyPath = join(TLS_DIR, "key.pem");
  const sanPath = join(TLS_DIR, "san.json");
  const ips = Array.from(new Set(["127.0.0.1"].concat(lanAddresses().map((a) => a.address)))).sort();
  let current = null;
  try {
    current = JSON.parse(readFileSync(sanPath, "utf8"));
    if (!current || !Array.isArray(current.ips)) current = null;
  } catch {}
  const same = current && current.ips.length === ips.length &&
    current.ips.every((v, i) => v === ips[i]);
  if (!same || !existsSync(certPath) || !existsSync(keyPath)) {
    const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "3650",
      "-subj", "/CN=oc-phone-link",
      "-addext", "subjectAltName=" + ips.map((ip) => "IP:" + ip).join(",")];
    log("tls: issuing cert for", ips.length, "address(es)");
    const r = spawnSync("openssl", args, { windowsHide: true, encoding: "utf8", timeout: 30000 });
    if (r.error) {
      log("tls: openssl not found; refusing to serve");
      return false;
    }
    if (r.status !== 0) {
      log("tls: openssl failed", (r.stderr || "").slice(0, 200));
      return false;
    }
    try { writeFileSync(sanPath, JSON.stringify({ ips: ips }, null, 2)); }
    catch (e) { log("tls: san set not persisted", e.message); return false; }
  }
  tls = {
    cert: readFileSync(certPath, "utf8"),
    key: readFileSync(keyPath, "utf8"),
    fingerprint: fingerprintOf(readFileSync(certPath, "utf8")),
    ips: ips,
  };
  return true;
}

const run = (args) => {
  const r = spawnSync("opencode", args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};

let cache = { at: 0, password: "" };
function password() {
  const fromEnv = process.env.OC_PHONE_LINK_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || "";
  if (fromEnv) { cache = { at: Date.now(), password: fromEnv }; return fromEnv; }
  if (Date.now() - cache.at < PASSWORD_NEG_TTL) return cache.password;
  const r = run(["service", "get", "password"]);
  const value = r.ok && r.out ? r.out.split(/\r?\n/).pop().trim() : "";
  cache = { at: Date.now(), password: value };
  return value;
}

const BEACON_PORTS = new Set([UDP_PORT, HTTPS_PORT, PROXY_PORT, LOOPBACK_PORT, EXPOSED_PORT]);

function selfPort() {
  const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (r.status !== 0) return 0;
  const own = String(process.pid);
  const found = new Set();
  for (const line of (r.stdout || "").split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!m || m[2] !== own) continue;
    const p = Number(m[1]);
    if (p >= 1024 && !BEACON_PORTS.has(p)) found.add(p);
  }
  if (found.size > 1) {
    log("selfPort ambiguous", found.size, "listeners; use opencode service status");
    return 0;
  }
  return found.size === 1 ? found.values().next().value : 0;
}

let optsPort = 0;
let portCache = { at: 0, port: 0, ttl: 0 };
function port() {
  if (portCache.port && Date.now() - portCache.at < portCache.ttl) return portCache.port;
  let p = 0;
  let source = "default";
  if (Number.isFinite(optsPort) && optsPort > 0) { p = optsPort; source = "ctx"; }
  else if (Number(process.env.OC_PHONE_LINK_UPSTREAM || 0) > 0) {
    p = Number(process.env.OC_PHONE_LINK_UPSTREAM); source = "env";
  } else {
    const sp = selfPort();
    if (sp) { p = sp; source = "selfPort"; }
    else {
      const s = run(["service", "status"]);
      const m = s.out.match(/:(\d+)\s*$/m);
      if (m) { p = Number(m[1]); source = "opencode service status"; }
    }
  }
  portCache = { at: Date.now(), port: p || OPENCODE_PORT, ttl: p ? 30000 : 2000 };
  log("upstream port", portCache.port, "source", source);
  return portCache.port;
}

function publicInfo() {
  const addrs = lanAddresses();
  const primary = addrs[0] ? addrs[0].address : "127.0.0.1";
  return {
    v: 2,
    app: APP_ID,
    agent: VERSION,
    name: hostname(),
    url: "https://" + primary + ":" + PROXY_PORT,
    agentUrl: "https://" + primary + ":" + HTTPS_PORT,
    port: port(),
    hosts: addrs.map((a) => a.address),
    fingerprint: tls.fingerprint,
    ts: Date.now(),
  };
}

function privateInfo() { return { ...publicInfo(), devices: state.keys.length }; }
function payload() { return Buffer.from(JSON.stringify(publicInfo())); }

const LOOPBACK_ORIGIN = /^https?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

function cors(req) {
  const h = {
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  };
  const origin = req && req.headers ? req.headers.origin || "" : "";
  if (LOOPBACK_ORIGIN.test(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Vary"] = "Origin";
  }
  return h;
}

function json(req, res, code, obj, extra) {
  res.writeHead(code, { ...cors(req), ...extra, "Content-Type": "application/json", "Referrer-Policy": "no-referrer" });
  res.end(JSON.stringify(obj));
}

const KEY_COOKIE_ATTRS = "Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=" + KEY_COOKIE_MAX_AGE;
const OWNER_COOKIE_ATTRS = "Path=/; HttpOnly; SameSite=Strict";
const keyCookieAttrs = () => KEY_COOKIE_ATTRS + "; Expires=" +
  new Date(now() + KEY_COOKIE_MAX_AGE * 1000).toUTCString();

function addCookieWith(headers, name, value, attrs) {
  const c = name + "=" + encodeURIComponent(value) + "; " + attrs;
  const prev = headers["set-cookie"];
  headers["set-cookie"] = prev ? (Array.isArray(prev) ? prev.concat([c]) : [prev, c]) : [c];
}

function addCookie(headers, name, value) {
  addCookieWith(headers, name, value, keyCookieAttrs());
}

const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"]
  .includes(req.socket && req.socket.remoteAddress);

function ownerPost(req) {
  if (!isLocal(req)) return false;
  if (!ownerToken(req)) return false;
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = String(req.headers.origin || "");
  if (origin && !LOOPBACK_ORIGIN.test(origin)) return false;
  const type = String(req.headers["content-type"] || "").toLowerCase();
  if (type && !type.startsWith("application/json")) return false;
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    let done = false;
    const finish = (value) => { if (done) return; done = true; resolve(value); };
    req.on("data", (c) => {
      raw += c;
      if (raw.length > BODY_CAP) { finish({}); req.destroy(); }
    });
    req.on("end", () => {
      try { finish(JSON.parse(raw || "{}")); }
      catch { finish({}); }
    });
    req.on("close", () => finish({}));
  });
}

const esc = (s) => String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stamp = (v) => Number.isFinite(v) ? new Date(v).toLocaleString() : "\u2014";

function loopPage() {
  const ready = password() !== "";
  const hasPin = !!(state.pin && state.pin.hash);
  const pinBlock = hasPin
    ? '<p class="dim">PIN set. Enter it once on the phone.</p>'
    : '<p class="dim">No PIN yet. Set one here, then enter the same PIN on the phone.</p>\n' +
      '<p><input id="pin" type="password" inputmode="numeric" autocomplete="new-password" placeholder="8 digits" size="18">' +
      '<button data-set-pin="1">Set PIN</button></p>';
  const claim = state.pinClaim;
  const claimLine = claim
    ? '\n  <p class="dim">Set from ' + esc(claim.name || "unknown") + ' at ' + esc(claim.ip || "?") +
      ' on ' + esc(stamp(claim.at)) + '</p>'
    : "";
  const keyRows = (state.keys || []).map((k) =>
    "<tr><td>" + esc(k.name || "\u2014") + "</td><td>" + esc(k.device || "\u2014") + "</td>" +
    "<td>" + esc(stamp(k.issued)) + "</td><td>" + esc(stamp(k.lastUsed)) + "</td>" +
    "<td>" + esc(k.lastIp || "\u2014") + "</td>" +
    '<td><button class="danger" data-revoke-key="' + esc(k.h) + '">Revoke</button></td></tr>').join("") ||
    '<tr><td colspan="6" class="dim">none</td></tr>';
  return '<!doctype html><meta charset="utf-8"><title>oc-phone-link</title>\n' +
    '<style>\n' +
    '  :root{color-scheme:dark}\n' +
    '  body{margin:0;background:#04060c;color:#eaf4ff;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}\n' +
    '  main{max-width:760px;margin:0 auto;padding:32px 20px 64px}\n' +
    '  h1{font-size:22px;margin:0 0 4px} h2{font-size:14px;letter-spacing:.18em;text-transform:uppercase;color:#7c8fa6;margin:28px 0 8px}\n' +
    '  table{width:100%;border-collapse:collapse;font-size:14px}\n' +
    '  td,th{border:1px solid #14202e;padding:6px 10px;text-align:left}\n' +
    '  .dim{color:#7c8fa6} .ok{color:#7dffc4} .bad{color:#ff9d9d}\n' +
    '  .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}\n' +
    '  input{background:#0b111a;border:1px solid #14202e;color:#eaf4ff;border-radius:10px;padding:6px 10px;font-size:15px}\n' +
    '  button{background:#7fe3ff;border:0;border-radius:10px;padding:6px 14px;font-size:14px;cursor:pointer}\n' +
    '  button.danger{background:#3a1418;color:#ffb3b3}\n' +
    '</style>\n<main>\n  <h1>oc-phone-link</h1>\n' +
    '  <div class="dim">beacon ' + esc(VERSION) + ' \u00b7 OpenCode ' +
    '<span class="' + (ready ? "ok" : "bad") + '">' + (ready ? "ready (:" + port() + ")" : "not ready") + '</span></div>\n' +
    '  <h2>PIN</h2>\n  ' + pinBlock + claimLine + '\n' +
    '  <h2>Devices</h2>\n' +
    '  <table><tr><th>Name</th><th>Device</th><th>Issued</th><th>Last used</th><th>Last IP</th><th></th></tr>' +
    keyRows + '</table>\n' +
    '  <p><button class="danger" data-revoke-all="1">Revoke all</button> <button data-reset-pin="1">Reset PIN</button></p>\n' +
    '  <p class="dim">Revoke all drops every phone key; the PIN and owner token stay. Reset PIN forgets the PIN and every key, but keeps the owner token.</p>\n' +
    '  <h2>Verify</h2>\n' +
    '  <p class="mono">OC-PHONE-LINK/1 fp:' + esc(tls.fingerprint) + ' short:' + esc(shortFingerprint(tls.fingerprint)) +
    ' host:' + esc(hostname()) + '</p>\n' +
    '  <p class="dim">Compare the short form with the one your phone shows before entering the PIN.</p>\n' +
    '</main>\n<script>\n' +
    '  const post = (path, body) => fetch(path, { method: "POST",\n' +
    '    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) })\n' +
    '    .then(async (r) => {\n' +
    '      if (!r.ok) {\n' +
    '        let msg = "The PC could not complete that action.";\n' +
    '        try {\n' +
    '          const j = await r.json();\n' +
    '          if (j.error === "save-failed") {\n' +
    '            msg = "The PC could not write its state file. Nothing was changed; check agent.log.";\n' +
    '          } else if (j.error) msg = j.error;\n' +
    '        } catch {}\n' +
    '        alert(msg);\n' +
    '        return;\n' +
    '      }\n' +
    '      location.reload();\n' +
    '    })\n' +
    '    .catch(() => alert("The PC did not answer."));\n' +
    '  document.querySelectorAll("[data-revoke-key]").forEach((b) =>\n' +
    '    b.onclick = () => post("/revoke", { key: b.dataset.revokeKey }));\n' +
    '  document.querySelectorAll("[data-reset-pin]").forEach((b) =>\n' +
    '    b.onclick = () => { if (confirm("Forget the PIN and every device key?")) post("/reset", {}); });\n' +
    '  document.querySelectorAll("[data-set-pin]").forEach((b) =>\n' +
    '    b.onclick = () => {\n' +
    '      const el = document.getElementById("pin");\n' +
    '      const pin = el ? el.value.trim() : "";\n' +
    '      if (!/^\\d{8}$/.test(pin)) { alert("Exactly 8 digits"); return; }\n' +
    '      if (confirm("Set this PIN? The phone enters it once.")) post("/setup", { pin });\n' +
    '    });\n' +
    '  document.querySelectorAll("[data-revoke-all]").forEach((b) =>\n' +
    '    b.onclick = () => { if (confirm("Forget every device?")) post("/revoke", {}); });\n' +
    '</script>';
}

function stripBeaconParams(path) {
  try {
    const u = new URL(path || "/", "https://127.0.0.1");
    for (const key of Array.from(u.searchParams.keys())) {
      if (/^ocpl_/i.test(key) || /^(device|token)$/i.test(key)) u.searchParams.delete(key);
    }
    return u.pathname + (u.search || "") + (u.hash || "");
  } catch { return path; }
}

function forwardedHeaders(req) {
  const fwd = { ...req.headers, host: "127.0.0.1:" + port() };
  for (const k of Object.keys(fwd)) {
    // A key bootstrapped from ?ocpl_key= must not ride along in a Referer.
    if (/^x-ocpl-/i.test(k) || /^refer(?:r)?er$/i.test(k)) delete fwd[k];
  }
  if (!fwd.authorization || !String(fwd.authorization).length) {
    const pw = password();
    if (pw) fwd.authorization = "Basic " + Buffer.from("opencode:" + pw).toString("base64");
  }
  if (fwd.cookie) {
    const kept = String(fwd.cookie).split(";").map((p) => p.trim())
      .filter((p) => p && !/^ocpl_/i.test(p));
    if (kept.length) fwd.cookie = kept.join("; ");
    else delete fwd.cookie;
  }
  return fwd;
}

const agent = new HttpAgent({ keepAlive: true, maxSockets: 32 });

function proxy(req, res) {
  const why = gate(req);
  if (why) {
    log("proxy gated", (req.socket && req.socket.remoteAddress) || "?", why, (req.url || "/").split("?")[0]);
    return json(req, res, 401, { ok: false, error: why });
  }
  const fwd = forwardedHeaders(req);
  const ak = req[ACTIVE_KEY] || activeKey(req);
  const upstream = httpRequest({
    host: "127.0.0.1",
    port: port(),
    method: req.method,
    path: stripBeaconParams(req.url),
    headers: fwd,
    agent: agent,
    timeout: 0,
  }, (r) => {
    clearTimeout(timer);
    const headers = { ...r.headers };
    if ("access-control-allow-origin" in headers) {
      const origin = req.headers.origin || "";
      if (LOOPBACK_ORIGIN.test(origin)) headers["access-control-allow-origin"] = origin;
      else delete headers["access-control-allow-origin"];
    }
    if (ak) addCookie(headers, "ocpl_key", req[ROTATED_KEY] || ak.key);
    headers["referrer-policy"] = "no-referrer";
    res.writeHead(r.statusCode || 502, headers);
    if (res.flushHeaders) res.flushHeaders();
    r.pipe(res);
  });
  // Connect/first-header deadline only. Once headers arrive the response may
  // stream (SSE, logs) or hold open (WebSocket) for as long as it needs.
  const timer = setTimeout(() => upstream.destroy(new Error("upstream-no-headers")), UPSTREAM_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  const failUpstream = () => {
    clearTimeout(timer);
    if (!res.headersSent) json(req, res, 502, { ok: false, error: "upstream" });
    else res.end();
  };
  upstream.on("error", failUpstream);
  req.pipe(upstream);
}

function upgradeProxy(req, clientSocket, head) {
  let why = "pin";
  try { why = gate(req); } catch (e) { why = "pin"; }
  if (why) {
    const body = JSON.stringify({ ok: false, error: why });
    try {
      clientSocket.write("HTTP/1.1 401 Unauthorized\r\n" +
        "Content-Type: application/json\r\nContent-Length: " + Buffer.byteLength(body) + "\r\n" +
        "Cache-Control: no-store\r\nConnection: close\r\n\r\n" + body);
      clientSocket.end();
    } catch {}
    return;
  }
  const fwd = forwardedHeaders(req);
  const line = (req.method || "GET") + " " + stripBeaconParams(req.url) +
    " HTTP/" + (req.httpVersion || "1.1") + "\r\n";
  const headerBytes = Object.keys(fwd).map((k) => {
    const v = Array.isArray(fwd[k]) ? fwd[k].join(", ") : fwd[k];
    return k + ": " + v + "\r\n";
  }).join("");
  const upstream = connect({ host: "127.0.0.1", port: port() });
  let replied = false;
  upstream.on("connect", () => {
    try {
      upstream.write(line);
      upstream.write(headerBytes);
      upstream.write("\r\n");
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    } catch (e) {
      log("upgrade write failed", e.message);
      replied = true;
      try { clientSocket.destroy(); } catch {}
    }
  });
  const timer = setTimeout(() => {
    if (!replied) {
      replied = true;
      try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); } catch {}
      try { upstream.destroy(); } catch {}
    }
  }, UPSTREAM_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  upstream.once("data", () => clearTimeout(timer));
  upstream.on("error", () => {
    clearTimeout(timer);
    if (!replied) {
      replied = true;
      try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); } catch {}
    } else {
      try { clientSocket.destroy(); } catch {}
    }
  });
  clientSocket.on("error", () => { clearTimeout(timer); try { upstream.destroy(); } catch {} });
  clientSocket.on("close", () => { clearTimeout(timer); try { upstream.destroy(); } catch {} });
  upstream.on("close", () => { clearTimeout(timer); try { clientSocket.destroy(); } catch {} });
}

function upstreamState(cb) {
  const sock = connect({ host: "127.0.0.1", port: port(), timeout: UPSTREAM_PROBE_MS });
  let done = false;
  const finish = (stateName) => {
    if (done) return;
    done = true;
    try { sock.destroy(); } catch {}
    cb(stateName);
  };
  sock.once("connect", () => finish("up"));
  sock.once("timeout", () => finish("down"));
  sock.once("error", () => finish("down"));
}

async function handleAgent(req, res, opts) {
  try {
    const url = new URL(req.url || "/", "https://127.0.0.1");
    const exposed = !!(opts && opts.exposed);
    // A tunnel terminates TLS and every visitor arrives from loopback. Owner
    // routes are never served on an exposed listener, whatever the source IP.
    if (exposed && ["/setup", "/reset", "/revoke"].includes(url.pathname)) {
      return json(req, res, 404, { ok: false, error: "not-here" });
    }
    if (req.method === "OPTIONS") { res.writeHead(204, cors(req)); res.end(); return; }
    if (url.pathname === "/health") return upstreamState((upstream) => {
      try { json(req, res, 200, { ok: true, agent: VERSION, upstream: upstream, port: port() }); }
      catch (e) { log("health error", e.message); }
    });
    if (url.pathname === "/auth" && req.method === "GET") {
      return json(req, res, 200, { ok: true, hasPin: !!(state.pin && state.pin.hash) });
    }
    if (url.pathname === "/setup" && req.method === "POST") {
      const ip = (req.socket && req.socket.remoteAddress) || "?";
      const owner = ownerPost(req);
      if (!owner && !isPrivatePeer(ip)) {
        if (req.resume) req.resume();
        logSetupRefused(ip);
        return json(req, res, 403, { ok: false, error: "local-only" });
      }
      if (state.pin && state.pin.hash) {
        if (req.resume) req.resume();
        return json(req, res, 409, { ok: false, error: "pin-exists" });
      }
      if (owner) {
        const b = await readBody(req);
        if (state.pin && state.pin.hash) return json(req, res, 409, { ok: false, error: "pin-exists" });
        const err = await setPin(b.pin);
        if (err === "save-failed") return json(req, res, 500, { ok: false, error: "save-failed" });
        if (err) return json(req, res, 400, { ok: false, error: err });
        return json(req, res, 200, { ok: true });
      }
      // First PIN from the phone. Bound like /auth; the KDF queue stays at two.
      if (!authEnter(ip)) {
        if (req.resume) req.resume();
        return json(req, res, 429, { ok: false, error: "throttled", retryAfter: 1 },
          { "Retry-After": "1" });
      }
      let setupTimer = null;
      const b = await new Promise((resolve) => {
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          if (setupTimer) clearTimeout(setupTimer);
          resolve(v);
        };
        setupTimer = setTimeout(() => {
          log("setup body timeout", ip);
          try { req.destroy(); } catch {}
          finish({});
        }, AUTH_BODY_TIMEOUT_MS);
        setupTimer.unref?.();
        readBody(req).then(finish, () => finish({}));
      });
      if (state.pin && state.pin.hash) {
        authLeave(ip);
        return json(req, res, 409, { ok: false, error: "pin-exists" });
      }
      const pin = String(b.pin || "");
      if (!pinPattern.test(pin)) {
        authLeave(ip);
        return json(req, res, 400, { ok: false, error: "pin-invalid" });
      }
      const key = randomBytes(24).toString("hex");
      const t = Date.now();
      const dev = typeof b.device === "string" && b.device.length > 0 &&
        b.device.length <= DEVICE_ID_MAX ? b.device : null;
      const name = typeof b.name === "string" && b.name.length > 0 &&
        b.name.length <= NAME_MAX ? b.name : null;
      let err;
      try {
        err = await setPin(pin, {
          claim: { ip: ip, name: name },
          keyRecord: { h: sha256hex(key), issued: t, lastUsed: t,
            lastIp: ip, device: dev, name: name },
        });
      } finally { authLeave(ip); }
      if (err === "pin-exists") return json(req, res, 409, { ok: false, error: "pin-exists" });
      if (err === "save-failed") return json(req, res, 500, { ok: false, error: "save-failed" });
      if (err) return json(req, res, 400, { ok: false, error: err });
      return json(req, res, 200, { ok: true, key: key });
    }
    if (url.pathname === "/reset" && req.method === "POST") {
      if (!ownerPost(req)) {
        if (req.resume) req.resume();
        return json(req, res, 403, { ok: false, error: "owner-only" });
      }
      const beforePin = state.pin;
      const beforeClaim = state.pinClaim;
      const beforeKeys = (state.keys || []).slice();
      state.pin = null;
      state.pinClaim = null;
      state.keys = [];
      if (!saveState(state)) {
        state.pin = beforePin;
        state.pinClaim = beforeClaim;
        state.keys = beforeKeys;
        return json(req, res, 500, { ok: false, error: "save-failed" });
      }
      authFails.clear();
      setupRefused.clear();
      log("pin and device keys reset; owner kept");
      return json(req, res, 200, { ok: true });
    }
    if (url.pathname === "/auth" && req.method === "POST") {
      if (!state.pin || !state.pin.hash) {
        if (req.resume) req.resume();
        return json(req, res, 409, { ok: false, error: "no-pin" });
      }
      const ip = (req.socket && req.socket.remoteAddress) || "?";
      if (!beginGuess(ip)) {
        const wait = authBlocked(ip);
        if (req.resume) req.resume();
        return json(req, res, 429, { ok: false, error: "throttled", retryAfter: wait },
          { "Retry-After": String(wait) });
      }
      if (!authEnter(ip)) {
        if (req.resume) req.resume();
        return json(req, res, 429, { ok: false, error: "throttled", retryAfter: 1 },
          { "Retry-After": "1" });
      }
      let released = false;
      let timer = null;
      const release = () => {
        if (released) return;
        released = true;
        if (timer) clearTimeout(timer);
        authLeave(ip);
      };
      timer = setTimeout(() => {
        log("auth body timeout", ip);
        release();
        req.destroy();
      }, AUTH_BODY_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      req.once("close", release);
      const b = await readBody(req);
      if (released) return;
      const pin = String(b.pin || "");
      if (!pinPattern.test(pin)) {
        release();
        return json(req, res, 400, { ok: false, error: "pin-invalid" });
      }
      if (!await pinMatches(pin)) {
        const armed = (authFails.get(ip) || {}).count >= AUTH_FAIL_MAX;
        log("pin rejected", ip, armed ? "locked " + (AUTH_WINDOW_MS / 60000) + "m" : "");
        release();
        return json(req, res, 401, { ok: false, error: "bad-pin" });
      }
      noteAuthOk(ip);
      const key = randomBytes(24).toString("hex");
      if (!Array.isArray(state.keys)) state.keys = [];
      const beforeKeys = state.keys.slice();
      const t = now();
      const dev = typeof b.device === "string" && b.device.length > 0 &&
        b.device.length <= DEVICE_ID_MAX ? b.device : null;
      const name = typeof b.name === "string" && b.name.length > 0 &&
        b.name.length <= NAME_MAX ? b.name : null;
      state.keys.push({ h: sha256hex(key), issued: t, lastUsed: t,
        lastIp: ip, device: dev, name: name });
      if (state.keys.length > KEY_CAP) state.keys = state.keys.slice(-KEY_CAP);
      if (!saveState(state)) {
        state.keys = beforeKeys;
        log("device key not persisted: rolled back", ip);
        release();
        return json(req, res, 500, { ok: false, error: "save-failed" });
      }
      log("device key minted", ip, "keys:", state.keys.length);
      release();
      return json(req, res, 200, { ok: true, key: key });
    }
    if (url.pathname === "/" || url.pathname === "/info") {
      const why = gate(req, { owner: true });
      if (why) return json(req, res, 401, { ok: false, error: why });
      return json(req, res, 200, privateInfo());
    }
    if (req.method === "POST" && url.pathname === "/request") {
      return json(req, res, 410, { ok: false, error: "retired" });
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      if (!ownerPost(req)) {
        if (req.resume) req.resume();
        return json(req, res, 403, { ok: false, error: "owner-only" });
      }
      const b = await readBody(req);
      const r = revoke(b.key || null);
      if (!r.saved) return json(req, res, 500, { ok: false, error: "save-failed", revoked: false, keys: r.keys });
      return json(req, res, 200, { ok: true, revoked: r.revoked, keys: r.keys });
    }
    return proxy(req, res);
  } catch (e) {
    log("handler error", e.message);
    if (!res.headersSent) json(req, res, 500, { ok: false });
  }
}

async function handleLoopback(req, res) {
  try {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (!isLocal(req)) { if (req.resume) req.resume(); res.writeHead(403); res.end(); return; }
    if (url.pathname === "/" && req.method === "GET" && url.searchParams.has("owner")) {
      const token = url.searchParams.get("owner") || "";
      if (!hexEq(token, state.owner)) { res.writeHead(403); res.end(); return; }
      const headers = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
      };
      addCookieWith(headers, "ocpl_owner", token, OWNER_COOKIE_ATTRS);
      res.writeHead(303, { ...headers, Location: "/" });
      res.end();
      return;
    }
    if (!ownerToken(req)) {
      if (req.resume) req.resume();
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end('{"ok":false,"error":"owner-only"}');
      return;
    }
    if (req.method === "POST" && url.pathname === "/setup") {
      if (!ownerPost(req)) { if (req.resume) req.resume(); res.writeHead(403); res.end(); return; }
      if (state.pin && state.pin.hash) {
        if (req.resume) req.resume();
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end('{"ok":false,"error":"pin-exists"}');
        return;
      }
      const b = await readBody(req);
      if (state.pin && state.pin.hash) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end('{"ok":false,"error":"pin-exists"}');
        return;
      }
      const err = await setPin(b.pin);
      if (err) {
        res.writeHead(err === "save-failed" ? 500 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err }));
        return;
      }
      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/reset") {
      if (!ownerPost(req)) { if (req.resume) req.resume(); res.writeHead(403); res.end(); return; }
      const beforePin = state.pin;
      const beforeClaim = state.pinClaim;
      const beforeKeys = (state.keys || []).slice();
      state.pin = null;
      state.pinClaim = null;
      state.keys = [];
      if (!saveState(state)) {
        state.pin = beforePin;
        state.pinClaim = beforeClaim;
        state.keys = beforeKeys;
        log("pin reset not persisted: rolled back");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"ok":false,"error":"save-failed"}');
        return;
      }
      authFails.clear();
      setupRefused.clear();
      log("pin and device keys reset; owner kept");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === "POST" && url.pathname === "/revoke") {
      if (!ownerPost(req)) { if (req.resume) req.resume(); res.writeHead(403); res.end(); return; }
      const b = await readBody(req);
      const r = revoke(b.key || null);
      if (!r.saved) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "save-failed", revoked: false, keys: r.keys }));
        return;
      }
      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "frame-ancestors 'none'",
      });
      res.end(loopPage());
      return;
    }
    res.writeHead(404);
    res.end("nope");
  } catch (e) {
    log("loopback error", e.message);
    try { if (!res.headersSent) { res.writeHead(500); res.end(); } else res.end(); } catch {}
  }
}

export function startBeacon(opts) {
  const G = Symbol.for("oc-phone-link.beacon");
  const prev = globalThis[G];
  if (typeof prev === "function") {
    try { prev(); } catch (e) { log("previous beacon stop failed", e.message); }
    globalThis[G] = null;
  }
  optsPort = Number(opts && opts.port) || 0;
  const loaded = loadState();
  if (!loaded.ok) {
    log("state unavailable, refusing to serve:", loaded.error);
    console.error("oc-phone-link: state unavailable:", loaded.error);
    return () => {};
  }
  if (!ensureCert()) {
    log("tls unavailable, refusing to serve");
    console.error("oc-phone-link: TLS unavailable (openssl); refusing to serve");
    return () => {};
  }

  const reset = stateAfterResetFlag(loaded.state, process.argv);
  state = reset;
  if (reset !== loaded.state) {
    if (!saveState(state)) {
      state = loaded.state;
      log("state reset not persisted: rolled back");
    }
  }
  log("state loaded", "keys:", state.keys.length);

  let udp = null;
  let udpOk = !NO_UDP;
  let announce = null;
  if (NO_UDP) {
    log("udp disabled: OC_PHONE_LINK_NO_UDP");
  } else {
    udp = createSocket({ type: "udp4", reuseAddr: false });
    udp.on("error", (e) => { udpOk = false; log("udp unavailable", e.code || e.message); });
    udp.on("message", (msg, rinfo) => {
      if (msg.toString().trim() !== PROBE) return;
      try { udp.send(payload(), rinfo.port, rinfo.address); } catch (e) { log("reply fail", e.message); }
    });
    udp.bind(UDP_PORT, "0.0.0.0", () => { udp.setBroadcast(true); log("udp listening", UDP_PORT); });

    announce = setInterval(() => {
      if (!udpOk) return;
      const data = payload();
      const targets = new Set(["255.255.255.255"]);
      for (const a of lanAddresses()) {
        const ip = a.address.split(".").map(Number);
        const mask = (a.netmask || "255.255.255.0").split(".").map(Number);
        targets.add(ip.map((n, i) => (n & mask[i]) | (~mask[i] & 255)).join("."));
      }
      for (const t of targets) { try { udp.send(data, UDP_PORT, t); } catch {} }
    }, 3000);
    if (announce.unref) announce.unref();
  }

  const https = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => { handleAgent(req, res); });
  const proxyServer = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => proxy(req, res));
  proxyServer.requestTimeout = 0;
  proxyServer.headersTimeout = 60000;
  proxyServer.on("upgrade", (req, socket, head) => upgradeProxy(req, socket, head));
  const loopback = createHttpServer((req, res) => { handleLoopback(req, res); });

  const servers = [];
  const retryTimers = new Set();
  let stopping = false;
  const listen = (srv, portNum, host, tag) => {
    let wait = 2000;
    let retry = null;
    let tracked = false;
    srv.on("listening", () => {
      if (stopping) { try { srv.close(); } catch {} return; }
      wait = 2000;
      if (!tracked) { tracked = true; servers.push(srv); }
      log(tag + " listening", portNum);
    });
    srv.on("error", (e) => {
      if (stopping) return;
      const code = e.code || e.message;
      if (code !== "EADDRINUSE" && code !== "EACCES") {
        log(tag + " unavailable", code);
        return;
      }
      if (retry) return;
      log(tag + " unavailable", code, "retry in " + wait + "ms");
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        retry = null;
        if (stopping) return;
        wait = Math.min(wait * 2, 30000);
        try { srv.listen(portNum, host); }
        catch (err) { log(tag + " retry failed", err.message); }
      }, wait);
      if (timer.unref) timer.unref();
      retry = timer;
      retryTimers.add(timer);
    });
    srv.listen(portNum, host);
  };
  listen(https, HTTPS_PORT, BIND_HOST, "https");
  listen(proxyServer, PROXY_PORT, BIND_HOST, "proxy");
  listen(loopback, LOOPBACK_PORT, "127.0.0.1", "loopback");

  if (process.env.OC_PHONE_LINK_TRANSPORT === "tunnel") {
    const exposed = createHttpServer((req, res) => { handleAgent(req, res, { exposed: true }); });
    let exposedTracked = false;
    exposed.on("listening", () => {
      if (stopping) { try { exposed.close(); } catch {} return; }
      if (!exposedTracked) { exposedTracked = true; servers.push(exposed); }
    });
    exposed.on("error", (e) => log("exposed listener unavailable", e.code || e.message));
    exposed.listen(EXPOSED_PORT, "127.0.0.1");
    log("exposed listener 127.0.0.1:" + EXPOSED_PORT + " (plain http, tunnel-only)");
  }

  const aliveTimer = setInterval(() => {
    log("alive", VERSION, "keys", (state.keys || []).length, "up " + Math.round(process.uptime()) + "s");
  }, 600000);
  if (aliveTimer.unref) aliveTimer.unref();

  log("beacon up", VERSION, "port " + port(), "bind " + BIND_HOST,
    "udp " + (NO_UDP ? "off" : "on"), "fp " + tls.fingerprint.slice(0, 12));
  console.log(JSON.stringify({
    app: APP_ID,
    agent: VERSION,
    url: publicInfo().url,
    panel: "http://127.0.0.1:" + LOOPBACK_PORT + "/?owner=" + state.owner,
  }));

  const stop = () => {
    stopping = true;
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    clearInterval(announce);
    clearInterval(aliveTimer);
    try { if (udp) udp.close(); } catch {}
    for (const srv of servers) { try { srv.close(); } catch {} }
    if (globalThis[Symbol.for("oc-phone-link.beacon")] === stop) globalThis[Symbol.for("oc-phone-link.beacon")] = null;
    log("beacon stopped");
  };
  globalThis[Symbol.for("oc-phone-link.beacon")] = stop;
  return stop;
}

const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");

export const __test = {
  handleAgent,
  handleLoopback,
  loadState,
  stateAfterResetFlag,
  getState: () => state,
  setState: (s) => { state = s; },
  freshState: blankState,
  clearLimits: () => {
    reqHits.clear(); authFails.clear(); setupRefused.clear();
    authInFlight = 0; authInFlightByIp.clear();
  },
  setClock: (fn) => { now = typeof fn === "function" ? fn : () => Date.now(); },
  paths: { data: DATA_DIR, state: STATE, log: LOG, tls: TLS_DIR },
  pinHash,
  sha256hex,
  payload,
  gate,
  activeKey,
  touchKey,
  keyRecord,
  addCookie,
  revoke,
  proxy,
  upgradeProxy,
  forwardedHeaders,
  stripBeaconParams,
  ensureCert,
  ownerToken,
  ownerPost,
  isPrivatePeer,
  shortFingerprint,
  selfPort,
  port,
  password,
  deriveStats: () => ({ active: deriveActive, peak: derivePeak, queued: deriveQueue.length, total: deriveTotal }),
  resetDeriveStats: () => { derivePeak = deriveActive; deriveTotal = 0; },
  setUpstreamPort: (p) => { portCache = { at: Date.now(), port: p, ttl: 60000 }; },
  cookieAttrs: KEY_COOKIE_ATTRS,
  ownerCookieAttrs: OWNER_COOKIE_ATTRS,
  constants: {
    STATE_VERSION, PIN_ITER, DERIVE_MAX, PASSWORD_NEG_TTL, KEY_TTL, KEY_ROTATE_AFTER,
    KEY_COOKIE_MAX_AGE, KEY_CAP, UPSTREAM_TIMEOUT_MS, UPSTREAM_PROBE_MS, EXPOSED_PORT,
  },
};
