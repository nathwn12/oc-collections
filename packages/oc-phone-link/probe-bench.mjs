// Lens 5 measurement: UDP PROBE -> payload, and first proxied response, on
// loopback. Uses only the public startBeacon seam so it runs before and after
// the hot-path change and the numbers stay comparable.
//   node plugin/oc-phone-link/probe-bench.mjs
import { createServer as createHttpServer } from "node:http";
import { createSocket } from "node:dgram";
import { request as httpsRequest } from "node:https";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const BASE = Number(process.env.OC_PLP_BENCH_BASE || 49000);
const data = mkdtempSync(join(tmpdir(), "ocpl-bench-"));
process.env.OC_PHONE_LINK_PORT_BASE = String(BASE);
process.env.OC_PHONE_LINK_DATA_DIR = data;
process.env.OC_PHONE_LINK_BIND_HOST = "127.0.0.1";
process.env.OC_PHONE_LINK_PASSWORD = "bench";
delete process.env.OC_PHONE_LINK_NO_UDP;

const { startBeacon } = await import("./beacon.mjs");

const upstream = createHttpServer((_q, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end('{"upstream":true}');
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
process.env.OC_PHONE_LINK_UPSTREAM = String(upstream.address().port);

const stop = startBeacon();
await new Promise((r) => setTimeout(r, 500));

const probe = () => new Promise((resolve, reject) => {
  const s = createSocket("udp4");
  const t0 = performance.now();
  const guard = setTimeout(() => { try { s.close(); } catch {} reject(new Error("probe timeout")); }, 2000);
  s.once("message", (msg) => {
    clearTimeout(guard);
    const ms = performance.now() - t0;
    try { s.close(); } catch {}
    resolve({ ms, bytes: msg.length });
  });
  s.once("error", (e) => { clearTimeout(guard); reject(e); });
  s.send("OC_PHONE_LINK/1", BASE, "127.0.0.1");
});

const proxied = () => new Promise((resolve, reject) => {
  const t0 = performance.now();
  const r = httpsRequest({
    host: "127.0.0.1", port: BASE + 3, path: "/", method: "GET", rejectUnauthorized: false,
  }, (res) => {
    let n = 0;
    res.on("data", (c) => { n += c.length; });
    res.on("end", () => resolve({ ms: performance.now() - t0, status: res.statusCode, bytes: n }));
  });
  r.on("error", reject);
  r.end();
});

const fmt = (xs) => xs.map((x) => x.toFixed(1)).join(", ");
try {
  const p = [await probe(), await probe(), await probe(), await probe(), await probe()];
  const q = [await proxied(), await proxied(), await proxied(), await proxied(), await proxied()];
  console.log(`PROBE->payload ms: ${fmt(p.map((x) => x.ms))} (bytes ${p[0].bytes})`);
  console.log(`PROXY first response ms: ${fmt(q.map((x) => x.ms))} (status ${q[0].status})`);
} finally {
  stop();
  await new Promise((r) => upstream.close(r));
}
