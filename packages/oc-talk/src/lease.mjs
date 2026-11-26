// Lease policy for nstack board rows. Pure: no filesystem, no service, no clock
// read beyond the `now` a caller supplies.
//
// A row with no lease metadata is OLD SHAPE. It is still held: `isExpired` is
// false for it, so a stranger can never take it over by arguing that a lease
// never existed. Only an explicit lease that has run out is takeover material.
export const LEASE_TTL_MS = 5 * 60 * 1000;
export const LEASE_FIELDS = ['leaseUntil', 'heartbeat', 'takeoverReason', 'takeoverAt'];

export function leaseUntil(at, ttl = LEASE_TTL_MS) {
  const start = Date.parse(at);
  return new Date((Number.isFinite(start) ? start : Date.now()) + ttl).toISOString();
}

// True only when the row carries a parseable lease that has run out. Unknown,
// malformed or missing leases are "not expired": the safe direction is to keep
// the holder in place rather than steal on bad data.
export function isExpired(row, now) {
  const until = row && row.leaseUntil;
  if (typeof until !== 'string' || !until) return false;
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return false;
  const n = Date.parse(now);
  return t <= (Number.isFinite(n) ? n : Date.now());
}

// stamp = heartbeat. Re-claiming your own seam refreshes both the heartbeat and
// the expiry, so an active worker keeps its row without any extra tool call.
export function stamp(row, at, ttl = LEASE_TTL_MS) {
  row.heartbeat = at;
  row.leaseUntil = leaseUntil(at, ttl);
  return row;
}

// A takeover is never silent: the reason travels on the row as history.
export function noteTakeover(row, reason, at) {
  row.takeoverReason = String(reason);
  row.takeoverAt = at;
  return row;
}
