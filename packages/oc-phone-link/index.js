import { Plugin } from "@opencode/plugin";
import { startBeacon } from "./beacon.mjs";

let stop = null;

function portFrom(ctx) {
  const raw = ctx && (ctx.port ?? ctx.server?.port ?? ctx.server?.url);
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    try {
      const u = new URL(raw);
      const p = Number(u.port);
      if (Number.isFinite(p) && p > 0) return p;
    } catch {}
  }
  return 0;
}

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
