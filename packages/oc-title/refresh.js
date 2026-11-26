// Pure scope extraction: turn one user message into a usable title scope, or nothing.
// A tool-only or empty message never becomes a title, so no scope is invented.

const TOOL_PART = /^tool|tool_/i; // tool_use/tool_result parts carry no user request.

// isUser: a real OpenCode user message has type:"user" (Session.Message.User);
// role:"user" is tolerated for older/fake rows.
function isUser(m) {
  return Boolean(m) && (m.type === "user" || m.role === "user");
}

// createdOf: Session.Message.User requires time.created as a number.
function createdOf(m) {
  const t = m?.time;
  if (t && typeof t.created === "number") return t.created;
  if (typeof t === "number") return t;
  return undefined;
}

// textFromParts: tolerate a parts-shaped row; tool parts carry no user request.
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
  if (!isUser(message)) return undefined;
  const raw = typeof message.text === "string" && message.text.trim()
    ? message.text
    : textFromParts(message.parts);
  const scope = raw.replace(/\s+/g, " ").trim();
  return scope.length > 0 ? scope : undefined;
}

// newestUserMessage: the full context is read (no window), so the latest user
// request is chosen by its required time.created stamp, never by array order.
// If a user row has no usable stamp the answer is undefined, not a silent guess.
export function newestUserMessage(response) {
  const rows = Array.isArray(response) ? response : Array.isArray(response?.data) ? response.data : [];
  const users = rows.filter(isUser);
  if (!users.length) return undefined;
  if (!users.every((m) => createdOf(m) !== undefined)) return undefined;
  return users.reduce((a, b) => (createdOf(a) >= createdOf(b) ? a : b));
}
