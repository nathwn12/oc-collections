// Pure event and record helpers: map lifecycle events to states and read record fields.

export const STATE_FOR = { // The seven lifecycle events and their target states.
  "session.created": "active",
  "session.execution.started": "active",
  "session.execution.succeeded": "parked",
  "session.execution.failed": "parked",
  "session.execution.interrupted": "parked",
  "session.idle": "parked",
  "session.archived": "closed",
};

// sessionIDOf: pull a usable session id from an event, tolerating wrapped shapes.
export function sessionIDOf(event) {
  const d = event?.data ?? {};
  const id = d.sessionID ?? d.info?.id ?? event?.durable?.aggregateID;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

// seqOf: read a durable sequence number only when it is a number.
export function seqOf(event) {
  const seq = event?.durable?.seq;
  return typeof seq === "number" ? seq : undefined;
}

// isChild: detect a child session so it gets a body-only title and no archived guard.
export function isChild(record) {
  return Boolean(record?.parentID || record?.parent_id);
}

// isArchived: detect archived sessions so a closed state stays final.
export function isArchived(record) {
  return record?.archived === true || Boolean(record?.time?.archived);
}

// deriveState: infer a state from a record when no mapped event was seen.
// time.busy and time.idle are epoch timestamps, not flags, so a stale busy is
// only busy while it is later than the last idle. outcome records how the last
// run ended and is set on every session that ever ran, so it never means closed:
// only an archived record is closed.
export function deriveState(record) {
  if (isArchived(record)) return "closed";
  const busy = record?.time?.busy;
  const idle = record?.time?.idle;
  if (typeof busy === "number" && typeof idle === "number") return busy > idle ? "active" : "parked";
  if (typeof busy === "number") return "active";
  return "parked";
}
