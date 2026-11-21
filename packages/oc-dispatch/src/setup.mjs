// oc-dispatch — the installer seam.
//
// `preview` computes a change without writing; `apply` backs up, writes a temp
// file, re-validates the bytes, renames atomically and rolls back on failure.
// Both edit the JSONC text in place, so comments and key order survive: parsing
// and stringifying would erase them. Nothing here runs on plugin load.
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { stripJsonc } from './config.mjs';

function skipTrivia(s, i, end) {
  while (i < end) {
    const c = s[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      i += 2;
      while (i < end && s[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < end && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

function readString(s, i, end) {
  if (s[i] !== '"') return null;
  let j = i + 1;
  while (j < end) {
    if (s[j] === '\\') {
      j += 2;
      continue;
    }
    if (s[j] === '"') {
      try {
        return { value: JSON.parse(s.slice(i, j + 1)), start: i, end: j + 1 };
      } catch {
        return null;
      }
    }
    j += 1;
  }
  return null;
}

function skipValue(s, i, end) {
  const open = s[i];
  if (open === '"') return readString(s, i, end)?.end ?? i + 1;
  if (open === '{' || open === '[') {
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let j = i; j < end; j += 1) {
      const c = s[j];
      if (quote) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === '"') {
        quote = c;
        continue;
      }
      if (c === '/' && s[j + 1] === '/') {
        while (j < end && s[j] !== '\n') j += 1;
        continue;
      }
      if (c === '/' && s[j + 1] === '*') {
        j += 2;
        while (j < end && !(s[j] === '*' && s[j + 1] === '/')) j += 1;
        j += 1;
        continue;
      }
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
    }
    return end;
  }
  let j = i;
  while (j < end && s[j] !== ',' && s[j] !== '}' && s[j] !== ']') j += 1;
  return j;
}

function trimEnd(s, from, to) {
  let j = to;
  while (j > from && /\s/.test(s[j - 1])) j -= 1;
  return j;
}

/** Direct-child key spans of one object, with comment-aware value boundaries. */
function objectSpans(s, from, end) {
  const keys = new Map();
  if (s[from] !== '{') return { open: from, close: end, keys };
  let i = skipTrivia(s, from + 1, end);
  while (i < end && s[i] !== '}') {
    const key = readString(s, i, end);
    if (!key) {
      i = skipTrivia(s, i + 1, end);
      continue;
    }
    i = skipTrivia(s, key.end, end);
    if (s[i] !== ':') {
      i = skipTrivia(s, i + 1, end);
      continue;
    }
    const valueStart = skipTrivia(s, i + 1, end);
    const valueEnd = trimEnd(s, valueStart, skipValue(s, valueStart, end));
    keys.set(key.value, { keyStart: key.start, valueStart, valueEnd });
    i = skipTrivia(s, valueEnd, end);
    if (s[i] === ',') i = skipTrivia(s, i + 1, end);
  }
  return { open: from, close: i < end ? i : end, keys };
}

function rootSpan(s) {
  return objectSpans(s, skipTrivia(s, 0, s.length), s.length);
}

function applyEdits(text, edits) {
  return edits
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), text);
}

/** Compute the edit; return the exact bytes that would be written. No I/O. */
export function preview({ text, target, entry, depth, read = (p) => readFileSync(p, 'utf8') } = {}) {
  const source = typeof text === 'string' ? text : typeof target === 'string' ? read(target) : null;
  if (typeof source !== 'string') return { ok: false, reason: 'config-unreadable' };
  let before;
  try {
    before = JSON.parse(stripJsonc(source));
  } catch {
    return { ok: false, reason: 'config-invalid' };
  }
  if (!before || typeof before !== 'object' || Array.isArray(before)) return { ok: false, reason: 'config-not-object' };
  if (entry !== undefined && (typeof entry !== 'string' || !entry)) return { ok: false, reason: 'bad-entry' };
  if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) return { ok: false, reason: 'bad-depth' };

  const root = rootSpan(source);
  const edits = [];
  const plugins = root.keys.get('plugins');
  const hasEntry = Array.isArray(before.plugins) && typeof entry === 'string' && before.plugins.includes(entry);
  if (typeof entry === 'string' && !hasEntry) {
    if (plugins && source[plugins.valueStart] === '[') {
      let at = plugins.valueEnd - 1;
      while (at > plugins.valueStart && /\s/.test(source[at - 1])) at -= 1;
      edits.push({ start: at, end: at, text: `${before.plugins.length ? ', ' : ''}${JSON.stringify(entry)}` });
    } else if (!plugins) {
      edits.push({ start: root.open + 1, end: root.open + 1, text: `\n  "plugins": [${JSON.stringify(entry)}],` });
    } else {
      return { ok: false, reason: 'plugins-not-array' };
    }
  }

  if (depth !== undefined) {
    const experimental = root.keys.get('experimental');
    if (experimental && source[experimental.valueStart] === '{') {
      const inner = objectSpans(source, experimental.valueStart, experimental.valueEnd);
      const depthKey = inner.keys.get('subagent_depth');
      if (depthKey) {
        edits.push({ start: depthKey.valueStart, end: depthKey.valueEnd, text: String(depth) });
      } else {
        let at = inner.close - 1;
        while (at > inner.open && /\s/.test(source[at - 1])) at -= 1;
        const comma = Object.keys(before.experimental ?? {}).length ? ',' : '';
        edits.push({ start: at, end: at, text: `${comma}\n    "subagent_depth": ${depth}\n  ` });
      }
    } else if (!experimental) {
      edits.push({ start: root.open + 1, end: root.open + 1, text: `\n  "experimental": { "subagent_depth": ${depth} },` });
    } else {
      return { ok: false, reason: 'experimental-not-object' };
    }
  }

  const afterText = applyEdits(source, edits);
  let after;
  try {
    after = JSON.parse(stripJsonc(afterText));
  } catch {
    return { ok: false, reason: 'edit-invalid' };
  }
  return {
    ok: true,
    changed: JSON.stringify(before) !== JSON.stringify(after),
    before,
    after,
    text: afterText,
    edits: edits.length,
  };
}

/**
 * Apply an explicitly requested setup. Never called from plugin load.
 * A pre-existing `.bak` is left alone; a failed validation restores the bytes.
 */
export function apply({
  target,
  entry,
  depth,
  read = (p) => readFileSync(p, 'utf8'),
  write = (p, data) => writeFileSync(p, data),
  rename = (from, to) => renameSync(from, to),
  copy = (from, to) => copyFileSync(from, to),
  exists = (p) => existsSync(p),
  remove = (p) => unlinkSync(p),
} = {}) {
  if (typeof target !== 'string' || !target) return { ok: false, reason: 'no-target' };
  const planned = preview({ target, entry, depth, read });
  if (!planned.ok) return { ok: false, reason: planned.reason };
  if (!planned.changed) return { ok: true, changed: false, path: target, backup: null };

  let original;
  const backup = `${target}.bak`;
  const temp = `${target}.tmp-${process.pid}`;
  try {
    original = read(target);
    if (!exists(backup)) copy(target, backup);
  } catch {
    return { ok: false, reason: 'backup-failed' };
  }
  try {
    write(temp, planned.text);
    const check = preview({ text: read(temp), entry, depth });
    if (!check.ok) throw new Error('invalid-write');
    rename(temp, target);
    return { ok: true, changed: true, path: target, backup: exists(backup) ? backup : null };
  } catch {
    try {
      write(target, original);
    } catch {
      /* report the rollback failure through reason */
    }
    try {
      remove(temp);
    } catch {
      /* a stray temp is harmless next to a restored target */
    }
    return { ok: false, reason: 'write-rolled-back' };
  }
}
