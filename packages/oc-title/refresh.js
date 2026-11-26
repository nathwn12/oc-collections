// Pure scope extraction: turn one user message into a usable title scope, or nothing.
// A tool-only or empty message never becomes a title, so no scope is invented.

const TOOL_PART = /^tool|tool_/i; // tool_use/tool_result parts carry no user request.

// textFromParts: join only the text parts of a message, skipping tool parts.
function textFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  let out = "";
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const type = typeof part.type === "string" ? part.type : "";
    if (TOOL_PART.test(type)) continue;
    const text = typeof part.text === "string" ? part.text : (type === "text" && typeof part.content === "string" ? part.content : "");
    if (text) out += (out ? " " : "") + text;
  }
  return out;
}

// scopeFromMessage: the raw (uncleaned) scope from a user message, or undefined.
// Cleaning, lowercasing and capping belong to title.js via the writer.
export function scopeFromMessage(message) {
  if (!message || typeof message !== "object" || message.role !== "user") return undefined;
  const raw = typeof message.text === "string" && message.text.trim()
    ? message.text
    : textFromParts(message.parts);
  const scope = raw.replace(/\s+/g, " ").trim();
  return scope.length > 0 ? scope : undefined;
}

// newestUserMessage: pick the latest user row from a bounded, newest-first read.
// Explicit timestamps win when the rows are not ordered by the host.
export function newestUserMessage(response) {
  const rows = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];
  const users = rows.filter((m) => m && m.role === "user");
  if (!users.length) return undefined;
  const stamp = (m) => (typeof m?.time?.created === "number" ? m.time.created : (typeof m?.time === "number" ? m.time : undefined));
  if (users.every((m) => stamp(m) !== undefined)) {
    return users.reduce((a, b) => (stamp(a) >= stamp(b) ? a : b));
  }
  return users[0];
}
