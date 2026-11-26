// Pure title helpers: build the canonical `<state>: <text>` title without a ctx.

export const STATES = ["active", "parked", "closed"]; // The only legal state words.

const PREFIX = /^(active|parked|closed)\s*:\s*/i; // One leading state prefix.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g; // Invisible code points to drop.

// stateOf: report the leading state so callers can compare without rebuilding a title.
export function stateOf(title) {
  if (typeof title !== "string") return null;
  const m = PREFIX.exec(title.trimStart());
  return m ? m[1].toLowerCase() : null;
}

// bodyOf: drop every leading state prefix and trim the remaining body.
export function bodyOf(title) {
  let s = typeof title === "string" ? title : "";
  let prev;
  do {
    prev = s;
    s = s.replace(PREFIX, "");
  } while (s !== prev);
  return s.trim();
}

// LONE: a surrogate half with no partner, which no encoder can represent.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// cleanBody: remove control points and stray halves, collapse whitespace and
// cap the body. The cap counts code points: slicing UTF-16 units can cut an
// emoji in half and leave a lone surrogate in the title.
export function cleanBody(title, maxLength = 200) {
  const s = bodyOf(title).replace(CONTROL, "").replace(LONE, "").replace(/\s+/g, " ").trim();
  if (!(maxLength > 0)) return s;
  const points = Array.from(s);
  return points.length > maxLength ? points.slice(0, maxLength).join("") : s;
}

// normalizeTitle: lowercase the cleaned body and prefix it only when a state is given.
export function normalizeTitle(title, state, { fallbackTitle = "untitled session", maxLength = 200 } = {}) {
  const body = (cleanBody(title, maxLength) || fallbackTitle).toLowerCase();
  return state == null ? body : `${state}: ${body}`;
}
