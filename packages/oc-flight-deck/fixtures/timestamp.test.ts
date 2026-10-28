import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, mergeOptions, resolveConfig } from "../src/tui/config.js";
import { formatTimestamp } from "../src/tui/format.js";
import { sidebarLines } from "../src/tui/presentation.js";
import { statLine } from "../src/tui/stats.js";

// The opt-in `updated` row draws the newest action the host recorded as an
// absolute timestamp. Two properties matter more than the rest: a default
// install must not grow the row (or walk the message list for it), and the
// presentation must be a config choice through Intl rather than a hand-rolled
// pattern. Every clock assertion below pins a fixed instant AND an explicit
// zone where the shape matters, so the suite cannot drift with the machine's
// locale or time zone.

/** A fixed instant with a distinct date and hour in every zone under test. */
const FIXED = Date.UTC(2026, 9, 27, 14, 32, 7);

const UTC_24H = {
  locale: "en-US",
  dateStyle: "short",
  timeStyle: "medium",
  hour12: false,
  timeZone: "UTC",
} as const;

describe("formatTimestamp", () => {
  test("writes a fixed instant in the named zone, on the requested clock", () => {
    expect(formatTimestamp(FIXED, { ...UTC_24H })).toBe("10/27/26, 14:32:07");
    expect(formatTimestamp(FIXED, { ...UTC_24H, hour12: true })).toBe("10/27/26, 2:32:07 PM");
    // The zone is the caller's, not the host's: the same instant in Tokyo and
    // in a fixed +05:30 offset proves the conversion is Intl's own.
    expect(formatTimestamp(FIXED, { ...UTC_24H, timeZone: "Asia/Tokyo" })).toBe("10/27/26, 23:32:07");
    expect(formatTimestamp(FIXED, { ...UTC_24H, timeZone: "+05:30" })).toBe("10/27/26, 20:02:07");
  });

  test("lets the date and time halves be omitted independently", () => {
    expect(formatTimestamp(FIXED, { ...UTC_24H, dateStyle: "none" })).toBe("14:32:07");
    expect(formatTimestamp(FIXED, { ...UTC_24H, timeStyle: "none" })).toBe("10/27/26");
    expect(formatTimestamp(FIXED, { ...UTC_24H, dateStyle: "medium", timeStyle: "medium" })).toBe(
      "Oct 27, 2026, 14:32:07",
    );
  });

  test("defaults to a short date and a time with seconds", () => {
    // The formatter's own defaults, with only the locale and zone pinned so the
    // assertion is about the default styles rather than the host's settings.
    const hostZone = new Intl.DateTimeFormat("en-US", {
      dateStyle: "short",
      timeStyle: "medium",
    }).format(FIXED);
    expect(formatTimestamp(FIXED, { locale: "en-US" })).toBe(hostZone);
  });

  test("omits the zone rather than substituting one, so the host zone applies", () => {
    // ECMA-402: no `timeZone` means the host environment's zone. The oracle is
    // a formatter built with the same options and no zone, not a recomputation
    // in this repo, so a machine in any zone passes while a hardcoded zone in
    // the implementation fails.
    const oracle = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "medium", hour12: false }).format(
      FIXED,
    );
    expect(formatTimestamp(FIXED, { locale: "en-US", hour12: false })).toBe(oracle);
    // An empty or whitespace-only zone is the same absence, not a zone named "".
    expect(formatTimestamp(FIXED, { locale: "en-US", hour12: false, timeZone: "   " })).toBe(oracle);
  });

  test("draws nothing, rather than throwing, when it cannot draw", () => {
    // Both halves off can only ever produce a blank row.
    expect(formatTimestamp(FIXED, { dateStyle: "none", timeStyle: "none" })).toBeUndefined();
    // A Windows zone id is not an IANA identifier, and a malformed locale is
    // rejected by Intl: presentation is a display concern, so the row hides.
    expect(formatTimestamp(FIXED, { ...UTC_24H, timeZone: "Pacific Standard Time" })).toBeUndefined();
    expect(formatTimestamp(FIXED, { ...UTC_24H, locale: "not a locale!" })).toBeUndefined();
  });
});

describe("format.timestamp config", () => {
  test("is off the shipped rail and defaults to the host locale and zone", () => {
    expect(DEFAULT_CONFIG.sidebar.rows).not.toContain("updated");
    expect(DEFAULT_CONFIG.format.timestamp).toEqual({ dateStyle: "short", timeStyle: "medium" });

    const { config, issues } = resolveConfig({});
    expect(issues).toEqual([]);
    expect(config.format.timestamp).toEqual({ dateStyle: "short", timeStyle: "medium" });
    expect(config.format.timestamp.locale).toBeUndefined();
    expect(config.format.timestamp.timeZone).toBeUndefined();
    expect(config.format.timestamp.hour12).toBeUndefined();
  });

  test("accepts the row and a full presentation without reporting anything", () => {
    const { config, issues } = resolveConfig({ sidebar: { rows: ["updated"] }, format: { timestamp: UTC_24H } });
    expect(issues).toEqual([]);
    expect(config.sidebar.rows).toEqual(["updated"]);
    expect(config.format.timestamp).toEqual({ ...UTC_24H });
  });

  test("falls back leaf by leaf, naming the key it could not use", () => {
    const { config, issues } = resolveConfig({
      format: {
        timestamp: {
          locale: "not a locale!",
          dateStyle: "long",
          timeStyle: 42,
          hour12: "yes",
          timeZone: "Pacific Standard Time",
        },
      },
    });
    expect(config.format.timestamp).toEqual({ dateStyle: "short", timeStyle: "medium" });
    for (const path of [
      "format.timestamp.locale",
      "format.timestamp.dateStyle",
      "format.timestamp.timeStyle",
      "format.timestamp.hour12",
      "format.timestamp.timeZone",
    ]) {
      expect(issues.join(" ")).toContain(path);
    }
  });

  test("a malformed section falls back whole and is reported", () => {
    const { config, issues } = resolveConfig({ format: { timestamp: "UTC" } });
    expect(config.format.timestamp).toEqual({ dateStyle: "short", timeStyle: "medium" });
    expect(issues.join(" ")).toContain("format.timestamp must be an object");
  });

  test("refuses a presentation that can only draw a blank row", () => {
    const { config, issues } = resolveConfig({ format: { timestamp: { dateStyle: "none", timeStyle: "none" } } });
    expect(config.format.timestamp).toEqual({ dateStyle: "short", timeStyle: "medium" });
    expect(issues.join(" ")).toContain('both "none"');
  });

  test("merges host overrides into the file's timestamp leaves", () => {
    // Host options win key by key. `format.timestamp` is nested, so a host that
    // names only the clock must not drop the file's zone.
    const merged = mergeOptions(
      { format: { timestamp: { timeZone: "UTC", hour12: false } } },
      { format: { timestamp: { hour12: true } } },
    );
    const { config, issues } = resolveConfig(merged);
    expect(issues).toEqual([]);
    expect(config.format.timestamp).toEqual({
      dateStyle: "short",
      timeStyle: "medium",
      hour12: true,
      timeZone: "UTC",
    });
  });
});

describe("the updated row", () => {
  test("draws the fixed action time in the configured shape", () => {
    const { config } = resolveConfig({ sidebar: { rows: ["updated"] }, format: { timestamp: UTC_24H } });
    expect(statLine("updated", { lastActionMs: FIXED }, { timestamp: config.format.timestamp })).toBe(
      "updated   10/27/26, 14:32:07",
    );
    expect(sidebarLines(config, { lastActionMs: FIXED })).toEqual(["updated   10/27/26, 14:32:07"]);
  });

  test("hides without a real action time, and draws the placeholder when persistent", () => {
    // 0 is 1970, the shape a missing stamp coerces into, not an action.
    for (const lastActionMs of [undefined, 0, -1]) {
      expect(statLine("updated", { lastActionMs }, {})).toBeUndefined();
    }
    const { config } = resolveConfig({ sidebar: { rows: ["updated"], persist: true } });
    expect(sidebarLines(config, {})).toEqual([`updated   ${DEFAULT_CONFIG.sidebar.placeholder}`]);
    // `persist: false` omits the row entirely, like every other data-less row.
    const omitting = resolveConfig({ sidebar: { rows: ["updated"], persist: false } });
    expect(sidebarLines(omitting.config, {})).toEqual([]);
  });

  test("stays off the shipped rail even when the source carries a time", () => {
    expect(sidebarLines(DEFAULT_CONFIG, { lastActionMs: FIXED })).not.toContain("updated");
  });
});
