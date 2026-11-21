// oc-dispatch — the record.
//
// One line per substitution: timestamp, model, tier, reason, cache age and
// spend so far. Tabs separate fields; any tab or newline in a field becomes a
// space, so a line stays one line. A log that cannot be written costs nothing.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const num = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const field = (value) => String(value ?? '-').replace(/[\t\r\n]+/g, ' ').trim() || '-';

export function formatLine({ model, tier, reason, cacheAgeMs = 0, spend = 0, at = new Date() } = {}) {
  const when = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  return [
    when,
    field(model),
    field(tier),
    field(reason),
    `${Math.max(0, Math.round(num(cacheAgeMs)))}ms`,
    `$${num(spend).toFixed(4)}`,
  ].join('\t');
}

export function appendLine(path, line) {
  if (typeof path !== 'string' || !path) return String(line ?? '');
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`);
  } catch {
    /* the record is best-effort */
  }
  return String(line ?? '');
}
