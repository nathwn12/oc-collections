import { Plugin } from "@opencode/plugin";
import { startBeacon } from "./beacon.mjs";

let stop = null;

// A V2 plugin context exposes options, not port or server members. The
// upstream port comes from the explicit option first, then the documented env
// override; anything else is left to the beacon, which must label its guess a
// fallback.
function portFrom(ctx) {
  const options = ctx && typeof ctx.options === "object" && ctx.options ? ctx.options : {};
  for (const raw of [options.upstreamPort, process.env.OC_PHONE_LINK_UPSTREAM]) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw <= 65535) return Math.trunc(raw);
    if (typeof raw !== "string" || !raw.trim()) continue;
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0 && n <= 65535) return Math.trunc(n);
    try {
      const u = new URL(raw);
      const p = Number(u.port);
      if (Number.isFinite(p) && p > 0 && p <= 65535) return p;
    } catch {}
  }
  return 0;
}

export { portFrom };
export default Plugin.define({
  id: "oc-phone-link",
  setup(ctx) {
    if (!stop) {
      try {
        const port = portFrom(ctx);
        stop = startBeacon(port ? { port } : {}) || null;
      } catch (e) {
        console.error("oc-phone-link: beacon failed to start:", e?.message || e);
        stop = null;
      }
    }
    return () => {
      if (stop) { stop(); stop = null; }
    };
  },
});
