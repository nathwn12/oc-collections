/**
 * oc-fallback - the record.
 *
 * One line per event: timestamp, session, agent, from, to, reason. An error
 * contributes its TYPE and STATUS and never its message, because a provider's
 * message can carry the request's Authorization header. Nothing here is
 * load-bearing: a log that cannot be written costs no request.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const field = (value) => String(value ?? '-').replace(/[\t\r\n]+/g, ' ').trim() || '-';

export function formatLine({
  at = new Date(),
  sessionID = '-',
  agent = '-',
  from = '-',
  to = '-',
  reason = '-',
  error,
} = {}) {
  const when = at instanceof Date ? at.toISOString() : new Date(at).toISOString();
  const why = error ? `${reason}:${error.type ?? 'error'}:${error.status ?? '-'}` : reason;
  return [when, sessionID, agent, from, to, why].map(field).join('\t');
}

/** A sink bound to one path: the durable line, then the same line on the console. */
export function makeLog(path, { console: sink = console } = {}) {
  return (line) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${line}\n`);
    } catch {
      /* a log that cannot be written never costs a request */
    }
    try {
      sink.log(`[oc-fallback] ${line}`);
    } catch {
      /* no console: the file line is the record */
    }
  };
}
