// Pure presence model: turn an OpenCode snapshot into a Discord Rich Presence
// activity, and decide when a card may be sent. No I/O, no clock, no timers:
// every result is a function of its arguments, so the whole card is provable
// offline.
//
// The owner's card: name is the app name (Discord draws it as the header over
// local IPC), details is 'Coding with <model display name>', state is
// 'Reasoning <Level>' (absent at default), large_text is '<providerID> \u00b7
// <version>', and timestamps.start is when OpenCode opened. The type stays 0
// (Playing). Discord itself draws the "Playing <app name>" activity-type line.

export const LIMITS = Object.freeze({
  TEXT: 128,
  IMAGE: 300,
  NAME: 128,
  BUTTON_LABEL: 32,
  BUTTON_URL: 512,
  BUTTONS: 2,
  IMAGE_TEXT_MIN: 2,
});

const DEFAULTS = Object.freeze({ appName: 'OpenCode', largeImage: '', buttons: [] });
const HTTP_URL = /^https?:\/\//i;

// asText: absent or wrong-typed fields are simply not present. A field that is
// not a string must never throw or become "[object Object]" on a card.
function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// configOf: only the options the card reads exist here. Everything else is the
// caller's business; a dead option would be a lie in the README.
function configOf(options) {
  const source = options && typeof options === 'object' ? options : {};
  return {
    appName: source.appName === undefined || source.appName === null
      ? DEFAULTS.appName
      : asText(source.appName),
    largeImage: asText(source.largeImage),
    appVersion: asText(source.appVersion),
    buttons: source.buttons === undefined || source.buttons === null ? [] : source.buttons,
  };
}

function snapshotOf(snapshot) {
  return snapshot && typeof snapshot === 'object' ? snapshot : {};
}

// An extension is a mark, a variation selector, a skin-tone modifier or a ZWJ.
// These belong to the base before them: cutting between the two produces
// either a lone accent or a half emoji, which is what "mojibake" means here.
const EXTENSION = /[\p{M}\u{1f3fb}-\u{1f3ff}]/u;

function extendsCluster(point, previous) {
  return Boolean(previous) && (previous.endsWith('\u200d') || EXTENSION.test(point) || point === '\uFE0F' || point === '\u200D');
}

// truncate: count code points, never UTF-16 units, so an emoji at the boundary
// is kept whole. Group extensions with their base and emit only whole groups;
// a group that does not fit is dropped rather than leaving a dangling accent.
// No ellipsis: Discord counts every code point, including the ellipsis.
export function truncate(text, max) {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  const source = typeof text === 'string' ? text : '';
  const points = Array.from(source);
  if (limit === 0 || points.length === 0) return '';
  if (points.length <= limit) return source;

  const groups = [];
  for (const point of points) {
    const previous = groups[groups.length - 1];
    if (previous !== undefined && extendsCluster(point, previous)) groups[groups.length - 1] = previous + point;
    else groups.push(point);
  }

  const kept = [];
  let used = 0;
  for (const group of groups) {
    const size = Array.from(group).length;
    if (used + size > limit) break;
    used += size;
    kept.push(group);
  }
  return kept.join('');
}

// formatEffort is the one level map for the reasoning line: variants are
// internal ids, 'default' (any case) and an empty variant mean no line at all,
// known levels get their display name, and any other id keeps its text with
// only the first letter capitalised.
const EFFORT_NAMES = Object.freeze({
  low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'XHigh', max: 'Max', minimal: 'Minimal',
});

export function formatEffort(value) {
  const raw = asText(value);
  if (!raw || raw.toLowerCase() === 'default') return '';
  return EFFORT_NAMES[raw.toLowerCase()] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

// prettifyModel: the offline fallback when ctx.model.list has no match or is
// unavailable. Split on id separators, keep a dot between digits as part of a
// version (v4.1), then capitalise each token. A leading 'v' followed by a digit
// becomes 'V4' through that rule. Known brand tokens keep their real casing so
// the fallback still reads like a name, not an id.
const TOKEN_CASE = Object.freeze({ deepseek: 'DeepSeek', opencode: 'OpenCode', gpt: 'GPT' });

export function prettifyModel(value) {
  const raw = asText(value);
  if (!raw) return '';
  const words = [];
  for (const part of raw.split(/[-_/]/)) {
    if (!part) continue;
    for (const piece of part.split(/(?<!\d)\.(?!\d)/)) {
      if (piece) words.push(piece);
    }
  }
  return words.map((word) => TOKEN_CASE[word.toLowerCase()]
    ?? word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// describe: choose the two text lines before assembly. Exported so tests and
// the README can state the layout in one place. details carries the model's
// human name from the catalogue, or the prettifier fallback, with no effort on
// that line. state is the reasoning level on its own line and is absent when
// the variant is default, missing or empty - never 'Reasoning Default'.
export function describe(snapshot, options) {
  const cfg = configOf(options);
  const data = snapshotOf(snapshot);
  const model = asText(data.model);
  const effort = formatEffort(data.effort);
  let details = '';
  let state = '';
  if (model) {
    const name = asText(data.modelName) || prettifyModel(asText(data.modelID) || model);
    details = truncate('Coding with ' + name, LIMITS.TEXT);
    if (effort) state = truncate('Reasoning ' + effort, LIMITS.TEXT);
  }
  return { details, state };
}

// buttons: a label is required; an empty one falls back to the URL host, which
// is the only name a link has. Invalid schemes are dropped, never rewritten to
// https, and only the first two survivors are sent.
function validButtons(buttons) {
  if (!Array.isArray(buttons)) return [];
  const out = [];
  for (const button of buttons) {
    if (out.length >= LIMITS.BUTTONS) break;
    if (!button || typeof button !== 'object') continue;
    const url = asText(button.url);
    if (!HTTP_URL.test(url)) continue;
    let host = '';
    try { host = new URL(url).hostname; }
    catch { continue; }
    const label = asText(button.label) || host;
    if (!label) continue;
    out.push({ label: truncate(label, LIMITS.BUTTON_LABEL), url: truncate(url, LIMITS.BUTTON_URL) });
  }
  return out;
}

// buildActivity: this layout is an owner decision, not an omission. Do not
// "improve" it back: no project, no agent, no title, no retry line, no per-turn
// busy flag and no idle variant belong on this card. An empty app name is the
// only reason to send no card at all.
export function buildActivity(snapshot, options) {
  const cfg = configOf(options);
  const data = snapshotOf(snapshot);
  const { details, state } = describe(data, cfg);
  if (!cfg.appName) return { activity: null, reason: 'no app name: nothing to show' };

  // name is the header over local IPC; details is no longer the app name (that
  // duplicated the header), it is the selected model. A middle dot does not
  // belong on either text line: effort has its own line.
  const activity = { type: 0 };
  if (details) activity.details = details;
  if (state) activity.state = state;
  activity.name = truncate(cfg.appName, LIMITS.NAME);

  const assets = {};
  const largeImage = truncate(cfg.largeImage, LIMITS.IMAGE);
  if (largeImage) assets.large_image = largeImage;
  // large_text names the provider and the app version. Omit it entirely when
  // neither part is known; join two known parts with an escaped middle dot so
  // this source stays ASCII. No small_image and no status_display_type.
  const provider = asText(data.modelProviderID);
  const version = cfg.appVersion;
  if (provider || version) {
    const text = provider && version ? provider + ' \u00b7 ' + version : (provider || version);
    assets.large_text = truncate(text, LIMITS.TEXT);
  }
  if (Object.keys(assets).length) activity.assets = assets;

  // openedAt is when OpenCode opened, not when a turn started: it is finite,
  // unconditional and keeps counting while the session is idle. Discord wants
  // unix seconds. With no openedAt there is no timestamps key at all.
  const openedAt = data.openedAt;
  if (typeof openedAt === 'number' && Number.isFinite(openedAt)) {
    activity.timestamps = { start: Math.floor(openedAt / 1000) };
  }

  const buttons = validButtons(cfg.buttons);
  if (buttons.length) activity.buttons = buttons;

  const chosen = ['name'];
  if (details) chosen.push('model');
  if (state) chosen.push('reasoning');
  if (activity.timestamps) chosen.push('openedAt');
  if (assets.large_text) chosen.push('provider+version');
  else if (activity.assets) chosen.push('image');
  if (activity.buttons) chosen.push('buttons');
  return { activity, reason: 'card: ' + chosen.join(' + ') };
}

// normalizeInterval: 0 disables the gate, sub-second values are too tight to
// be safe against Discord's rate limit, and a missing or broken value falls
// back to four seconds rather than silently disabling throttling.
export function normalizeInterval(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 4000;
  if (ms === 0) return 0;
  return ms < 1000 ? 1000 : ms;
}

// planAction: the send gate. An unchanged revision needs no work; a clear
// never waits and never spends the interval budget; a first send (lastSentMs
// 0) is always allowed. The interval itself lives on the request: this module
// takes no options beyond the request and the current time.
export function planAction(request, nowMs) {
  const req = request && typeof request === 'object' ? request : {};
  if (req.revision === req.sentRevision) return { action: 'idle', waitMs: 0 };
  if (req.desired === false) return { action: 'clear', waitMs: 0 };

  const interval = normalizeInterval(req.intervalMs ?? req.interval);
  const last = req.lastSentMs;
  if (interval > 0 && typeof last === 'number' && Number.isFinite(last) && last > 0) {
    const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : 0;
    const remaining = last + interval - now;
    if (remaining > 0) return { action: 'wait', waitMs: remaining };
  }
  return { action: 'send', waitMs: 0 };
}

// gateAfterAction: store the send time only if the gate did not move while the
// call was in flight. A clear (or any reset) that landed mid-send wins: it
// must not be held behind an interval that belonged to a card that ended.
// Every other action simply reports the gate as it stands now.
export function gateAfterAction(action, gateBefore, gateNow, sentAtMs) {
  if (action === 'send' && gateNow === gateBefore) return sentAtMs;
  return gateNow;
}
