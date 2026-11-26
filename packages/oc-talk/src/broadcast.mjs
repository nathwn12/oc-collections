// Read-only fan-out planner. It does not send anything and adds no tool: the
// existing talk_send transport already addresses one session per call. A caller
// that wants a group takes this plan and executes the returned targets itself,
// so talk_send's input/output typing is untouched.
export const BROADCAST_MAX = 20;

export function broadcastPlan(sessions, text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    return { error: 'bad_request', reason: 'text must be a non-empty string' };
  }
  if (!Array.isArray(sessions)) {
    return { error: 'bad_request', reason: 'sessions must be an array of session ids' };
  }
  const cap = Number.isInteger(opts && opts.max) && opts.max > 0 ? Math.min(opts.max, BROADCAST_MAX) : BROADCAST_MAX;
  const seen = new Set();
  const targets = [];
  for (const value of sessions) {
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) continue;
    seen.add(value);
    targets.push({ session: value, text });
    if (targets.length > cap) {
      return { error: 'bad_request', reason: 'too many broadcast targets; the cap is ' + cap, targets: targets.slice(0, cap) };
    }
  }
  return { targets };
}
