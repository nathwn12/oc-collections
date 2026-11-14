import { goPanelLines } from "./go-panel.js";
import type { GoUsage } from "./go-usage.js";
import type { RailLine } from "./presentation.js";

/** Codex's two meters share the Go renderer, not the Go provider or account. */
export function dexPanelLines(usage: GoUsage | undefined, now: number, label = "dex"): readonly RailLine[] {
  const header: RailLine = { field: "go", text: label, segments: [{ text: label, tone: "subdued" }] };
  const fresh = usage && { windows: usage.windows.filter(window => window.resetAtMs === undefined || window.resetAtMs > now) };
  return [header, ...goPanelLines(fresh, now, { labels: { rolling: "5h", weekly: "1w" } }, 0, !fresh?.windows.length ? "unavailable" : undefined).slice(0, 2)];
}
