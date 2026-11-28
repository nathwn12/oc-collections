// Pure reducer for the presence card: lifecycle events in, one snapshot out.
// No I/O and no clock reads for the card - the caller passes openedAt through
// options, and now only orders the bounded record cache. Every rule here is
// provable offline and a reload starts from createState() with no residue.

/**
 * @typedef {object} SessionRecord
 * @property {string} sessionID
 * @property {string|undefined} parentID
 * @property {string|undefined} title
 * @property {string|undefined} agent
 * @property {string|undefined} model
 * @property {string|undefined} effort
 * @property {boolean} busy informational only: the card no longer reads it
 * @property {boolean} retrying informational only: the card no longer reads it
 * @property {number} lastSeen
 */

/**
 * @typedef {object} ReducerState
 * @property {Map<string, SessionRecord>} sessions
 * @property {string|undefined} currentID
 * @property {number} revision
 */

/**
 * @typedef {object} Snapshot
 * @property {string|undefined} appName
 * @property {string|undefined} model
 * @property {string|undefined} modelProviderID
 * @property {string|undefined} effort
 * @property {number|undefined} openedAt
 * @property {number} revision
 * @property {number} sessions
 */

// The map is a cache, not a session ledger: OpenCode can open hundreds of
// sessions in a long run and the card only ever reads one of them. An unbounded
// map would grow for the life of the host for no visible benefit, so the oldest
// non-current record is evicted once the cap is reached.
const MAX_SESSIONS = 32;

function asString(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}

/**
 * splitModel: turn the host's model choice into the two strings the card prints
 * plus the identifiers the model catalogue needs for a human display name.
 * A bare string may carry a variant after '#'; an object carries it in variant
 * or effort. The model part comes from id, else modelID, else providerID/modelID.
 * No variant means effort stays undefined, never an empty string. The returned
 * id/modelID/providerID are the raw Model.Ref fields, with any '#variant' tail
 * removed, so the catalogue lookup can match on modelID before id.
 * @param {unknown} value
 * @returns {{model: string|undefined, effort: string|undefined, id: string|undefined, modelID: string|undefined, providerID: string|undefined}}
 */
export function splitModel(value) {
  let raw;
  let effort;
  let id;
  let modelID;
  let providerID;
  if (typeof value === 'string') {
    // A bare string is a model reference, not a providerID/modelID pair: keep
    // it whole so the fallback prettifier and the catalogue both see the id.
    raw = value;
    id = value;
    modelID = value;
  } else if (value && typeof value === 'object') {
    effort = asString(value.variant) ?? asString(value.effort);
    id = asString(value.id);
    modelID = asString(value.modelID) ?? id;
    providerID = asString(value.providerID);
    raw = id
      ?? (modelID ? (providerID ? providerID + '/' + modelID : modelID) : undefined);
  }
  const withoutVariant = (text) => {
    const found = asString(text);
    if (!found) return undefined;
    const hash = found.indexOf('#');
    return asString(hash < 0 ? found : found.slice(0, hash));
  };
  id = withoutVariant(id);
  modelID = withoutVariant(modelID);
  if (raw === undefined) return { model: undefined, effort, id, modelID, providerID };

  const hash = raw.indexOf('#');
  const model = asString(hash < 0 ? raw : raw.slice(0, hash));
  const embedded = hash < 0 ? undefined : asString(raw.slice(hash + 1));
  return { model, effort: effort ?? embedded, id, modelID, providerID };
}

/** @returns {ReducerState} */
export function createState() {
  return { sessions: new Map(), currentID: undefined, revision: 0 };
}

// Payloads arrive wrapped in data, sometimes once more in data.info. Reading
// both keeps the reducer working when the host changes its envelope.
function fieldOf(data, key) {
  if (!data || typeof data !== 'object') return undefined;
  if (data[key] !== undefined) return data[key];
  if (data.info && typeof data.info === 'object' && data.info[key] !== undefined) return data.info[key];
  return undefined;
}

function sessionIDOf(event, data) {
  const raw = fieldOf(data, 'sessionID') ?? data?.info?.id ?? event?.durable?.aggregateID;
  return typeof raw === 'string' && raw ? raw : undefined;
}

function textOf(value) {
  return typeof value === 'string' ? value : undefined;
}

function stampOf(now) {
  return typeof now === 'number' && Number.isFinite(now) ? now : 0;
}

// The revision tracks only what reaches the card. A rename, a tool call or a
// busy transition changes a record but not the picture, so it must not spend
// the rate-limit budget.
function cardKey(state) {
  const id = state?.currentID;
  const row = id && state.sessions instanceof Map ? state.sessions.get(id) : undefined;
  const ref = row?.modelRef;
  return [row?.model, row?.effort, ref ? JSON.stringify(ref) : undefined];
}

// A created record that names a model is knowledge; a default the host never
// reports stays blank. An explicit selection later overwrites the same fields.
function seedModel(record, data) {
  const value = fieldOf(data, 'model');
  if (value === undefined) return;
  const split = splitModel(value);
  record.model = split.model;
  record.effort = split.effort;
  // Keep the raw ref so the caller can resolve the model's human name from
  // ctx.model.list once, instead of printing an id on the card.
  record.modelRef = split.model === undefined ? undefined : {
    id: split.id,
    modelID: split.modelID,
    providerID: split.providerID,
  };
}

function blankRecord(sessionID, seen) {
  return {
    sessionID,
    parentID: undefined,
    title: undefined,
    agent: undefined,
    model: undefined,
    effort: undefined,
    modelRef: undefined,
    busy: false,
    retrying: false,
    lastSeen: seen,
  };
}

/**
 * Apply one host event without mutating the input.
 * @param {ReducerState} state
 * @param {unknown} event
 * @param {number} now epoch ms, used only to order the bounded cache
 * @returns {ReducerState} a new state; revision moves only on a visible change
 */
export function applyEvent(state, event, now) {
  const previous = state && typeof state === 'object' ? state : createState();
  const sessions = new Map(previous.sessions instanceof Map ? previous.sessions : []);
  const seen = stampOf(now);
  const type = typeof event?.type === 'string' ? event.type : '';
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const id = sessionIDOf(event, data);

  // An event with no usable id, or not from the session lifecycle, carries no
  // presence signal. Return a fresh state so callers can never mutate by alias.
  if (!id || !type.startsWith('session.')) {
    return { sessions, currentID: previous.currentID, revision: previous.revision };
  }

  const existing = sessions.get(id);
  // A child is learned once at session.created and stays a child on later
  // events, which rarely carry parentID again.
  const rawParent = textOf(fieldOf(data, 'parentID')) ?? textOf(fieldOf(data, 'parent_id'));
  const parentID = rawParent ?? existing?.parentID;
  const next = { ...(existing ?? blankRecord(id, seen)), lastSeen: seen };
  let currentID = previous.currentID;

  // The newest non-child event owns the card. A child never does: sub-agents
  // are work inside a turn, not a turn the user is watching. If a session turns
  // out to be a child after it was already current, drop the claim.
  if (parentID) {
    if (currentID === id) currentID = undefined;
  } else {
    currentID = id;
  }

  switch (type) {
    case 'session.created':
      next.parentID = parentID;
      next.title = textOf(fieldOf(data, 'title')) ?? next.title;
      next.agent = textOf(fieldOf(data, 'agent')) ?? next.agent;
      seedModel(next, data);
      break;
    case 'session.renamed': {
      const title = textOf(fieldOf(data, 'title'));
      if (title !== undefined) next.title = title;
      break;
    }
    case 'session.agent.selected': {
      const agent = textOf(fieldOf(data, 'agent'));
      if (agent !== undefined) next.agent = agent;
      break;
    }
    case 'session.model.selected': {
      // A malformed event with no model must not erase a real selection.
      seedModel(next, data);
      break;
    }
    case 'session.status': {
      const status = fieldOf(data, 'status');
      const kind = typeof status === 'string' ? status : status?.type;
      // busy and retry are tracked as facts about the session, but the card
      // reads neither: the elapsed clock runs from OpenCode's open time.
      next.busy = kind === 'busy';
      next.retrying = kind === 'retry';
      break;
    }
    case 'session.idle': // deprecated but still emitted; same turn boundary
      next.busy = false;
      next.retrying = false;
      break;
    default:
      // Tool events touch lastSeen and current only; nothing they carry is a
      // new fact about the card, so the revision stays put.
      break;
  }

  sessions.set(id, next);
  if (sessions.size > MAX_SESSIONS) {
    let victimID;
    let oldest = Infinity;
    for (const [key, row] of sessions) {
      if (key === currentID) continue;
      if (row.lastSeen < oldest) { oldest = row.lastSeen; victimID = key; }
    }
    if (victimID !== undefined) sessions.delete(victimID);
  }

  const before = cardKey(previous);
  const after = cardKey({ sessions, currentID });
  const changed = before[0] !== after[0] || before[1] !== after[1] || before[2] !== after[2];
  return { sessions, currentID, revision: changed ? previous.revision + 1 : previous.revision };
}

/**
 * The snapshot buildActivity takes. Only the current session's explicit model
 * choice is shown; openedAt, appName and the resolved modelName come from the
 * caller untouched.
 * @param {ReducerState} state
 * @param {{appName?: string, openedAt?: number, modelName?: string}} [options]
 * @returns {Snapshot}
 */
export function selectSnapshot(state, options) {
  const id = state?.currentID;
  const row = id && state.sessions instanceof Map ? state.sessions.get(id) : undefined;
  return {
    appName: options?.appName,
    model: row?.model,
    modelID: row?.modelRef?.modelID,
    modelProviderID: row?.modelRef?.providerID,
    effort: row?.effort,
    modelRef: row?.modelRef,
    modelName: options?.modelName,
    openedAt: options?.openedAt,
    revision: revisionOf(state),
    sessions: state?.sessions instanceof Map ? state.sessions.size : 0,
  };
}

/** @param {ReducerState} state @returns {number} */
export function revisionOf(state) {
  return typeof state?.revision === 'number' ? state.revision : 0;
}
