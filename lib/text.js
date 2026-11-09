// Small, dependency-free text helpers: frontmatter, globs, slugs, tables.

/** Split `---` frontmatter from a markdown body. Tolerates CRLF and quoted values. */
export function splitFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: source };

  const data = {};
  let key = null;
  for (const raw of match[1].split('\n')) {
    const line = raw.replace(/\r$/, '');
    const colon = line.indexOf(':');
    if (colon > 0 && !/^\s/.test(line)) {
      key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      data[key] = /^(>[+-]?|\|[+-]?)$/.test(value) ? '' : value;
    } else if (key !== null && line.trim() !== '') {
      data[key] = `${data[key]} ${line.trim()}`.trim();
    }
  }
  for (const k of Object.keys(data)) {
    data[k] = data[k].replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return { data, body: match[2] };
}

/** Filesystem-safe slug, stable for a given title. */
export function slug(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'seam';
}

/**
 * Minimal glob matcher for seam ownership.
 * Supports `*` (no separator), `**` (any depth), `?`, and a trailing `/` for a directory prefix.
 * Paths are normalised to forward slashes before matching.
 */
export function matchesGlob(pattern, file) {
  const target = file.replace(/\\/g, '/').replace(/^\.\//, '');
  let p = pattern.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!p) return false;
  if (p.endsWith('/')) p += '**';

  const rx = p
    .split('')
    .reduce((acc, ch, i, arr) => {
      if (ch === '*' && arr[i + 1] === '*') return acc; // handled by the pair below
      if (ch === '*' && arr[i - 1] === '*') {
        // `**` — collapse the duplicate and allow any depth
        return acc.endsWith('.*') ? acc.slice(0, -2) + '.*' : acc + '.*';
      }
      if (ch === '*') return acc + '[^/]*';
      if (ch === '?') return acc + '[^/]';
      if ('\\^$+.()|{}[]'.includes(ch)) return acc + '\\' + ch;
      return acc + ch;
    }, '');

  try {
    return new RegExp(`^${rx}$`).test(target);
  } catch {
    return false;
  }
}

/** A markdown table from rows of strings. */
export function table(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

/** `YYYY-MM-DD HH:MM` in local time, plus a UTC ISO stamp for the ledger. */
export function stamps(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    local: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    iso: date.toISOString(),
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
  };
}

/** Age of an ISO timestamp, in words. */
export function age(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown';
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
