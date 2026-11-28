// Focused seam tests for the server-side lenses. Sockets are used only where a
// header, a cookie, an upgrade or a bind cannot be proved through __test alone.
//   node --test plugin/oc-phone-link/beacon.test.mjs
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const DIR = mkdtempSync(join(tmpdir(), "ocpl-test-"));
// Windows can reserve 49500-49504 in an excluded port range: netstat reports
// the ports free but listen() fails EACCES. Keep the pinned block when it is
// usable, and otherwise use one fixed fallback block so back-to-back runs
// still exercise the same ports and reveal a leaked listener.
async function blockBindable(base) {
  const held = [];
  try {
    for (let i = 0; i < 5; i += 1) {
      const s = createNetServer();
      const ok = await new Promise((resolve) => {
        s.once("error", () => resolve(false));
        s.listen(base + i, "127.0.0.1", () => resolve(true));
      });
      if (!ok) return false;
      held.push(s);
    }
    return true;
  } finally {
    for (const s of held) await new Promise((resolve) => { try { s.close(resolve); } catch { resolve(); } });
  }
}
const BASE = (await blockBindable(49500)) ? 49500 : 51200;
const HTTPS_PORT = BASE + 1;
const PROXY_PORT = BASE + 3;
process.env.OC_PHONE_LINK_DATA_DIR = DIR;
process.env.OC_PHONE_LINK_BIND_HOST = "127.0.0.1";
process.env.OC_PHONE_LINK_PORT_BASE = String(BASE);
process.env.OC_PHONE_LINK_PASSWORD = "test-password-never-in-json";
process.env.OC_PHONE_LINK_NO_UDP = "1";

const { __test, startBeacon } = await import("./beacon.mjs");

const KEY = "stored-key";
const PIN = "12345678";
const nowMs = () => Date.now();
const ownerHeaders = () => ({ cookie: "ocpl_owner=" + __test.getState().owner });
const keyHeaders = () => ({ "x-ocpl-key": KEY });

async function seed() {
  const st = __test.freshState();
  const salt = "ab".repeat(16);
  st.pin = { salt, hash: (await __test.pinHash(PIN, salt)).toString("hex"), at: nowMs() };
  st.keys = [{ h: __test.sha256hex(KEY), issued: nowMs(), lastUsed: nowMs(),
    lastIp: null, device: "phone-a", name: "Pixel 9" }];
  __test.setState(st);
  __test.clearLimits();
  __test.setClock();
  __test.setUpstreamPort(HTTPS_PORT);
  __test.resetDeriveStats();
}

function mockReq(opts) {
  const q = new EventEmitter();
  q.url = opts.url || "/info";
  q.method = opts.method || "GET";
  q.headers = opts.headers || {};
  q.socket = { remoteAddress: opts.ip === undefined ? "192.168.1.50" : opts.ip };
  q.resume = () => {};
  q.pipe = () => {};
  return q;
}
function mockRes() {
  const s = new EventEmitter();
  s.writeHead = (code, headers) => { s.statusCode = code; s.headers = headers; };
  s.end = (body) => { s.body = body; };
  s.flushHeaders = () => {};
  return s;
}
async function call(fn, opts, payload) {
  const q = mockReq(opts || {});
  const s = mockRes();
  const pending = fn(q, s);
  if (payload !== undefined) { q.emit("data", JSON.stringify(payload)); q.emit("end"); }
  if (pending && typeof pending.then === "function") await pending;
  return s;
}
function httpsGet(port, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const r = httpsRequest({
      host: "127.0.0.1", port, path, method: "GET", rejectUnauthorized: false,
      headers: opts.headers || {},
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers, ms: performance.now() - t0 }));
    });
    r.on("error", reject);
    r.end();
  });
}
function httpCall(port, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = httpRequest({ host: "127.0.0.1", port, path,
      method: payload ? "POST" : "GET",
      headers: { ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(headers || {}) } }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function upgradeGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const r = httpsRequest({ host: "127.0.0.1", port, path, rejectUnauthorized: false, headers },
      (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, body: "" })); });
    r.on("upgrade", (res, socket, head) => {
      let data = head ? head.toString() : "";
      socket.on("data", (c) => { data += c.toString(); });
      socket.on("end", () => resolve({ status: res.statusCode, data }));
      setTimeout(() => { socket.destroy(); resolve({ status: res.statusCode, data }); }, 1200).unref();
    });
    r.on("error", reject);
    r.end();
  });
}
const listen = (srv, port) => new Promise((r) => srv.listen(port, "127.0.0.1", r));
const close = (srv) => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(seed);

describe("seam unit tests", { concurrency: false }, () => {
  test("L3 cookie is secure, http-only, strict and persistent", () => {
    assert.match(__test.cookieAttrs, /Secure/);
    assert.match(__test.cookieAttrs, /HttpOnly/);
    assert.match(__test.cookieAttrs, /SameSite=Strict/);
    assert.match(__test.cookieAttrs, /Max-Age=7776000/);
    const h = {};
    __test.addCookie(h, "ocpl_key", KEY);
    assert.equal(h["set-cookie"].length, 1);
    assert.match(h["set-cookie"][0], /^ocpl_key=/);
    assert.match(h["set-cookie"][0], /Max-Age=7776000/);
    assert.match(__test.ownerCookieAttrs, /HttpOnly/);
    assert.match(__test.ownerCookieAttrs, /SameSite=Strict/);
    assert.doesNotMatch(__test.ownerCookieAttrs, /Secure/);
  });

  test("L3 stored key: 10 fresh-session requests, 0 PIN prompts", async () => {
    for (let i = 0; i < 10; i += 1) {
      const s = await call(__test.handleAgent, { headers: keyHeaders() });
      assert.equal(s.statusCode, 200, "header request " + i);
      assert.notEqual(JSON.parse(s.body).error, "pin");
    }
    const viaCookie = await call(__test.handleAgent, { headers: { cookie: "ocpl_key=" + KEY } });
    assert.equal(viaCookie.statusCode, 200);
    const viaQuery = await call(__test.handleAgent, { url: "/info?ocpl_key=" + KEY });
    assert.equal(viaQuery.statusCode, 200);
  });

  test("loopback is not auth: no key gets 401 pin on /info and on the proxy", async () => {
    for (const ip of ["127.0.0.1", "::1", "192.168.1.50"]) {
      const info = await call(__test.handleAgent, { ip });
      assert.equal(info.statusCode, 401, ip);
      assert.equal(JSON.parse(info.body).error, "pin");
      const proxied = await call(__test.proxy, { ip });
      assert.equal(proxied.statusCode, 401, ip);
      assert.equal(JSON.parse(proxied.body).error, "pin");
    }
  });

  test("no PIN gives setup; a wrong key gives pin; an owner cookie only unlocks /info", async () => {
    __test.setState({ ...__test.freshState(), keys: [] });
    const setup = await call(__test.handleAgent, { ip: "127.0.0.1" });
    assert.equal(setup.statusCode, 401);
    assert.equal(JSON.parse(setup.body).error, "setup");
    __test.setState({ ...__test.getState(), pin: __test.getState().pin || {
      salt: "ab".repeat(16), hash: "00".repeat(32), at: nowMs() } });
    const wrong = await call(__test.handleAgent, { headers: { "x-ocpl-key": "wrong" } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(JSON.parse(wrong.body).error, "pin");
    const asOwner = await call(__test.handleAgent, { headers: ownerHeaders() });
    assert.equal(asOwner.statusCode, 200, "the owner cookie is accepted on /info");
    const ownerProxy = await call(__test.proxy, { headers: ownerHeaders() });
    assert.equal(ownerProxy.statusCode, 401, "the owner cookie is not a proxy key");
  });

  test("/info and the public payload never carry a password, paired flag or owner", async () => {
    const info = await call(__test.handleAgent, { headers: keyHeaders() });
    assert.equal(info.statusCode, 200);
    const j = JSON.parse(info.body);
    assert.equal(j.v, 2);
    assert.equal(j.password, undefined);
    assert.equal(j.paired, undefined);
    assert.equal(j.owner, undefined);
    assert.ok(!info.body.includes(process.env.OC_PHONE_LINK_PASSWORD));
    assert.equal(typeof j.devices, "number");
    assert.ok(!__test.payload().toString().includes(process.env.OC_PHONE_LINK_PASSWORD));
  });

  test("L3 revoked key returns 401 pin", async () => {
    const r = await call(__test.handleLoopback, { url: "/revoke", method: "POST", ip: "127.0.0.1",
      headers: ownerHeaders() }, { key: __test.sha256hex(KEY) });
    assert.equal(r.statusCode, 303, "panel revoke redirects");
    assert.deepEqual(__test.getState().keys, []);
    const s = await call(__test.handleAgent, { headers: keyHeaders() });
    assert.equal(s.statusCode, 401);
    assert.equal(JSON.parse(s.body).error, "pin");
  });

  test("L3 key expires after 90 days idle", async () => {
    __test.getState().keys[0].lastUsed = nowMs() - __test.constants.KEY_TTL - 1;
    const s = await call(__test.handleAgent, { headers: keyHeaders() });
    assert.equal(s.statusCode, 401);
    assert.equal(JSON.parse(s.body).error, "pin");
  });

  test("a key cookie renews its expiry from the clock on every use", async () => {
    const day = 24 * 60 * 60 * 1000;
    let t = nowMs();
    __test.setClock(() => t);
    const first = {};
    __test.addCookie(first, "ocpl_key", KEY);
    const firstLine = first["set-cookie"][0];
    assert.match(firstLine, /Max-Age=7776000/);
    const m1 = /Expires=([^;]+)/.exec(firstLine);
    assert.ok(m1, "the cookie carries an absolute expiry");
    const e1 = Date.parse(m1[1]);

    t += 80 * day;
    const later = {};
    __test.addCookie(later, "ocpl_key", KEY);
    const secondLine = later["set-cookie"][0];
    assert.match(secondLine, /Max-Age=7776000/, "the 90-day window is reissued at day 80");
    const m2 = /Expires=([^;]+)/.exec(secondLine);
    assert.ok(m2, "the renewed cookie carries an absolute expiry");
    assert.equal(Date.parse(m2[1]) - e1, 80 * day, "the cookie expiry slid 80 days with the clock");

    const live = await call(__test.handleAgent, { headers: keyHeaders() });
    assert.equal(live.statusCode, 200, "the key is still accepted at day 80");
    t += 11 * day;
    const after = await call(__test.handleAgent, { headers: keyHeaders() });
    assert.equal(after.statusCode, 200, "a key used at day 80 still opens day 91");
    __test.setClock();
  });

  test("v5 legacy string key normalises into a tagged record", async () => {
    const salt = "ab".repeat(16);
    const legacy = {
      v: 5,
      pin: { salt, hash: (await __test.pinHash(PIN, salt)).toString("hex"), at: nowMs() },
      keys: [__test.sha256hex(KEY)],
      owner: "0f".repeat(16),
    };
    writeFileSync(__test.paths.state, JSON.stringify(legacy));
    const loaded = __test.loadState();
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(typeof loaded.state.keys[0], "object");
    assert.equal(loaded.state.keys[0].lastIp, null);
    assert.equal(loaded.state.keys[0].device, null);
    assert.equal(loaded.state.keys[0].name, null);
    assert.ok(Number.isFinite(loaded.state.keys[0].issued));
  });

  test("v4 migration clears PIN and keys and drops devices and pending", async () => {
    const legacy = {
      v: 4,
      pin: { salt: "11".repeat(16), hash: "22".repeat(32), at: 1 },
      keys: [{ h: __test.sha256hex(KEY), issued: 1, lastUsed: 1 }],
      devices: [{ id: "phone-1", token: "plaintext-token", name: "old", pairedAt: 1 }],
      pending: [{ id: "phone-2", token: "plaintext-token" }],
    };
    writeFileSync(__test.paths.state, JSON.stringify(legacy));
    const loaded = __test.loadState();
    assert.equal(loaded.ok, true, loaded.error);
    assert.equal(loaded.state.v, 5);
    assert.equal(loaded.state.pin, null, "a pre-2.1 PIN is never kept");
    assert.deepEqual(loaded.state.keys, [], "pre-2.1 keys are never kept");
    assert.match(loaded.state.owner, /^[0-9a-f]{32}$/);
    assert.equal("devices" in loaded.state, false);
    assert.equal("pending" in loaded.state, false);
    const onDisk = JSON.parse(readFileSync(__test.paths.state, "utf8"));
    assert.deepEqual(onDisk, loaded.state);
    const logs = readFileSync(__test.paths.log, "utf8");
    assert.match(logs, /state migrated: PIN and keys cleared; set an 8-digit PIN on the PC, then pair the phone again/);
    assert.equal((logs.match(/state migrated/g) || []).length, 1, "one migration line only");
  });

  test("L8 rotation on use keeps the old key valid, keeps the tag and records the IP", async () => {
    const st = __test.getState();
    st.keys[0].issued = nowMs() - __test.constants.KEY_ROTATE_AFTER - 1;
    const first = await call(__test.handleAgent, { headers: keyHeaders(), ip: "192.168.1.77" });
    assert.equal(first.statusCode, 200);
    assert.equal(st.keys.length, 2, "one new key minted");
    assert.equal(st.keys[1].device, "phone-a");
    assert.equal(st.keys[1].name, "Pixel 9");
    assert.equal(st.keys[1].lastIp, "192.168.1.77");
    const second = await call(__test.handleAgent, { headers: keyHeaders() });
    assert.equal(second.statusCode, 200, "old key still accepted");
    assert.equal(st.keys.length, 2, "no repeat rotation on the old key");
  });

  test("per-key revoke drops exactly one key", async () => {
    const st = __test.getState();
    const other = "other-key";
    st.keys.push({ h: __test.sha256hex(other), issued: nowMs(), lastUsed: nowMs(),
      lastIp: null, device: "phone-b", name: "Other" });
    const r = await call(__test.handleAgent, { url: "/revoke", method: "POST", ip: "127.0.0.1",
      headers: { ...ownerHeaders(), "content-type": "application/json" } },
      { key: __test.sha256hex(other) });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true, revoked: 1, keys: 1 });
    assert.equal(st.keys.length, 1);
    assert.equal(st.keys[0].h, __test.sha256hex(KEY));
  });

  test("POST /request is retired", async () => {
    const r = await call(__test.handleAgent, { url: "/request", method: "POST" }, { device: "x" });
    assert.equal(r.statusCode, 410);
    assert.deepEqual(JSON.parse(r.body), { ok: false, error: "retired" });
  });

  test("gate contains no loopback exemption and the request path has no sync PBKDF2", () => {
    const src = readFileSync(new URL("./beacon.mjs", import.meta.url), "utf8");
    const m = /function gate\(req, opts\) \{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "gate source found");
    assert.doesNotMatch(m[1], /isLocal/);
    assert.doesNotMatch(src, /pbkdf2Sync/);
    assert.equal(__test.constants.PIN_ITER, 600000);
  });

  test("PIN derivations never exceed the global semaphore of 2", async () => {
    const salt = "cd".repeat(16);
    __test.resetDeriveStats();
    const hashes = await Promise.all(Array.from({ length: 5 }, () => __test.pinHash("87654321", salt)));
    assert.equal(hashes.length, 5);
    assert.ok(__test.deriveStats().peak <= 2, "peak " + __test.deriveStats().peak);
    assert.equal(__test.deriveStats().total, 5);
  });

  test("an upgrade without a device key is refused with 401", () => {
    const sock = new EventEmitter();
    const bytes = [];
    sock.write = (b) => { bytes.push(String(b)); };
    sock.end = (b) => { if (b) bytes.push(String(b)); };
    sock.destroy = () => {};
    __test.upgradeProxy(mockReq({ url: "/ws", headers: {}, ip: "127.0.0.1" }), sock, Buffer.alloc(0));
    const wire = bytes.join("");
    assert.match(wire, /^HTTP\/1\.1 401 Unauthorized/);
    assert.match(wire, /"error":"pin"/);
  });
});

describe("socket integration", { concurrency: false }, () => {
  test("L7 killed upstream: JSON 502 in <=1s, 5/5; /health names down state", async () => {
    const upstream = createHttpServer((_q, res) => { res.writeHead(200); res.end("up"); });
    await listen(upstream, 0);
    __test.setUpstreamPort(upstream.address().port);
    const stop = startBeacon();
    try {
      await wait(300);
      const healthy = await httpsGet(HTTPS_PORT, "/health");
      assert.equal(healthy.status, 200);
      assert.equal(JSON.parse(healthy.body).upstream, "up");

      await close(upstream);
      const times = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await httpsGet(PROXY_PORT, "/dead", { headers: keyHeaders() });
        times.push(Math.round(r.ms));
        assert.equal(r.status, 502, r.body);
        assert.equal(JSON.parse(r.body).error, "upstream");
      }
      assert.ok(times.every((t) => t <= 1000), "502 times: " + times.join(", ") + " ms");
      const after = await httpsGet(HTTPS_PORT, "/health");
      assert.equal(after.status, 200);
      assert.equal(JSON.parse(after.body).upstream, "down");
      console.log("L7 502 ms: " + times.join(", "));
    } finally { stop(); await close(upstream); }
  });

  test("L7 hung upstream (no response headers) 502s on the connect timeout", async () => {
    const hung = createHttpServer(() => {});
    await listen(hung, 0);
    __test.setUpstreamPort(hung.address().port);
    const stop = startBeacon();
    try {
      await wait(300);
      const r = await httpsGet(PROXY_PORT, "/hung", { headers: keyHeaders() });
      assert.equal(r.status, 502, r.body);
      assert.equal(JSON.parse(r.body).error, "upstream");
      assert.ok(r.ms >= 4500 && r.ms <= 8500, "connect timeout was " + Math.round(r.ms) + " ms");
      console.log("L7 hung 502 ms: " + Math.round(r.ms));
    } finally { stop(); await close(hung); }
  });

  test("L7 a slow body after headers is not killed", async () => {
    const slow = createHttpServer((_q, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      setTimeout(() => res.end("slow-but-alive"), 1800);
    });
    await listen(slow, 0);
    __test.setUpstreamPort(slow.address().port);
    const stop = startBeacon();
    try {
      await wait(300);
      const r = await httpsGet(PROXY_PORT, "/sse", { headers: keyHeaders() });
      assert.equal(r.status, 200, r.body);
      assert.equal(r.body, "slow-but-alive");
      assert.ok(r.ms >= 1500, "the body arrived after the old 800 ms idle kill: " + Math.round(r.ms));
    } finally { stop(); await close(slow); }
  });

  test("L7 an upgrade is gated, then replays with injected auth and stripped cookies", async () => {
    const upstream = createNetServer();
    let seen = "";
    upstream.on("connection", (sock) => {
      sock.on("data", (c) => {
        seen += c.toString();
        if (seen.includes("\r\n\r\n") && !sock.written) {
          sock.written = true;
          sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nECHO");
        }
      });
    });
    await listen(upstream, 0);
    __test.setUpstreamPort(upstream.address().port);
    const stop = startBeacon();
    try {
      await wait(300);
      const denied = await upgradeGet(PROXY_PORT, "/ws?ocpl_key=leak", {
        connection: "upgrade", upgrade: "websocket",
      });
      assert.equal(denied.status, 401);

      const allowed = await upgradeGet(PROXY_PORT, "/ws?ocpl_key=" + encodeURIComponent(KEY) + "&x=1", {
        connection: "upgrade", upgrade: "websocket",
        "x-ocpl-key": KEY, cookie: "ocpl_owner=secret; session=keep",
      });
      assert.equal(allowed.status, 101);
      assert.match(allowed.data, /ECHO/);
      assert.match(seen, /^GET \/ws\?x=1 HTTP\/1\.1/);
      assert.match(seen, /authorization: Basic /i);
      assert.doesNotMatch(seen, /ocpl_key/i);
      assert.doesNotMatch(seen, /ocpl_owner/i);
      assert.doesNotMatch(seen, /x-ocpl-key/i);
      assert.match(seen, /session=keep/);
    } finally { stop(); await close(upstream); }
  });

  test("L3 Set-Cookie on the proxy response carries Max-Age", async () => {
    const upstream = createHttpServer((_q, res) => { res.writeHead(200); res.end("up"); });
    await listen(upstream, 0);
    __test.setUpstreamPort(upstream.address().port);
    const stop = startBeacon();
    try {
      await wait(300);
      const r = await httpsGet(PROXY_PORT, "/info?ocpl_key=" + KEY, { headers: keyHeaders() });
      assert.equal(r.status, 200, r.body);
      const cookies = r.headers["set-cookie"] || [];
      assert.ok(cookies.some((c) => /^ocpl_key=/.test(c) && /Max-Age=7776000/.test(c)), JSON.stringify(cookies));
    } finally { stop(); await close(upstream); }
  });

  test("L7 a query-bootstrapped key in Referer never reaches upstream; replies carry no-referrer", async () => {
    let seen = null;
    const upstream = createHttpServer((q, res) => {
      seen = q.headers;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("up");
    });
    await listen(upstream, 0);
    __test.setUpstreamPort(upstream.address().port);
    const stop = startBeacon();
    try {
      await wait(300);
      const leak = "https://x/?ocpl_key=" + KEY + "&auth_token=leak-me";
      const r = await httpsGet(PROXY_PORT, "/probe", {
        headers: { ...keyHeaders(), referer: leak },
      });
      assert.equal(r.status, 200, r.body);
      assert.equal(r.body, "up");
      assert.ok(seen, "the upstream saw the proxied request");
      assert.equal(seen.referer, undefined, "no Referer reached upstream");
      assert.equal(seen.referrer, undefined, "no Referrer reached upstream");
      assert.ok(!Object.keys(seen).some((k) => /^refer(?:r)?er$/i.test(k)));
      assert.ok(!Object.values(seen).some((v) => String(v).includes(KEY)), "the key URL did not leak upstream");
      assert.equal(r.headers["referrer-policy"], "no-referrer");
    } finally { stop(); await close(upstream); }
  });

  test("L6 bind retry reclaims the port: /health 200 in <=32s, no restart", async () => {
    const holder = createHttpServer((_q, res) => { res.writeHead(200); res.end("holder"); });
    await listen(holder, HTTPS_PORT);
    const t0 = performance.now();
    const stop = startBeacon();
    let answer = null;
    try {
      await wait(250);
      await close(holder);
      const deadline = nowMs() + 32000;
      while (nowMs() < deadline) {
        try {
          answer = await httpsGet(HTTPS_PORT, "/health");
          if (answer.status === 200) break;
        } catch {}
        await wait(200);
      }
      const ms = Math.round(performance.now() - t0);
      assert.equal(answer && answer.status, 200, "beacon answered /health after the holder died");
      assert.ok(ms <= 32000, "reclaim took " + ms + " ms");
      assert.equal(globalThis[Symbol.for("oc-phone-link.beacon")], stop, "same beacon, no restart");
      console.log("L6 reclaim ms: " + ms);
    } finally { stop(); }
  });

  test("tunnel transport binds a plain-HTTP exposed listener with no owner routes", async () => {
    process.env.OC_PHONE_LINK_TRANSPORT = "tunnel";
    const stop = startBeacon();
    try {
      await wait(300);
      const port = __test.constants.EXPOSED_PORT;
      const cookies = { cookie: "ocpl_owner=" + __test.getState().owner };
      for (const path of ["/setup", "/reset", "/revoke"]) {
        const r = await httpCall(port, path, {}, { ...cookies, "sec-fetch-site": "same-origin" });
        assert.equal(r.status, 404, path + " " + r.text);
        assert.deepEqual(JSON.parse(r.text), { ok: false, error: "not-here" });
      }
      const keyed = await httpCall(port, "/info", undefined, { "x-ocpl-key": KEY });
      assert.equal(keyed.status, 200, "the exposed listener serves gated /info");
      const noKey = await httpCall(port, "/info");
      assert.equal(noKey.status, 401);
      assert.equal(JSON.parse(noKey.text).error, "pin");
    } finally {
      stop();
      delete process.env.OC_PHONE_LINK_TRANSPORT;
    }
  });

  test("the certificate SAN reissues when the persisted address set changes", async () => {
    const sanPath = join(DIR, "tls", "san.json");
    assert.equal(existsSync(sanPath), true, "the SAN set is persisted next to the cert");
    const persisted = JSON.parse(readFileSync(sanPath, "utf8"));
    assert.ok(persisted.ips.includes("127.0.0.1"));
    persisted.ips = ["127.0.0.1", "10.9.8.7"];
    writeFileSync(sanPath, JSON.stringify(persisted));
    assert.equal(__test.ensureCert(), true);
    const fresh = JSON.parse(readFileSync(sanPath, "utf8"));
    assert.doesNotMatch(JSON.stringify(fresh.ips), /10\.9\.8\.7/);
    assert.ok(fresh.ips.includes("127.0.0.1"));
    assert.match(readFileSync(join(DIR, "tls", "cert.pem"), "utf8"), /BEGIN CERTIFICATE/);
  });
});
