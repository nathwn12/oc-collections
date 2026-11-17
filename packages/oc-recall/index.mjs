import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const LIMITS = Object.freeze({ query: 2048, queryTerms: 32, files: 500, bytesPerFile: 1_000_000, totalBytes: 8_000_000, lines: 100_000, lineChars: 4096, lineTokens: 512, totalTokens: 500_000, results: 20, excerpt: 320 });
const tokenize = (text) => (text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_-]+/gu) ?? []);
const SENSITIVE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,})\b|\b(?:api[_ -]?key|access[_ -]?token|password|secret|client[_ -]?secret)\s*[:=]\s*["']?\S+/i;

/**
 * Search only the caller-approved relative paths beneath root. Reads are fresh per
 * call; invalid, missing, oversized, or escaped inputs fail closed as an empty result.
 */
export async function search({ query, root, files, limit = 10 } = {}) {
  if (typeof query !== 'string' || query.length > LIMITS.query || !query.trim() ||
      typeof root !== 'string' || !Array.isArray(files) || files.length > LIMITS.files ||
      !Number.isInteger(limit) || limit < 1 || limit > LIMITS.results) return { results: [], diagnostics: ['invalid-input'] };
  const terms = [...new Set(tokenize(query))].slice(0, LIMITS.queryTerms);
  if (!terms.length) return { results: [], diagnostics: [] };
  try {
    const realRoot = await realpath(root);
    if (!(await noLinks(path.parse(realRoot).root, realRoot))) return { results: [], diagnostics: ['root-link-rejected'] };
    const documents = [];
    const diagnostics = [];
    const seenPaths = new Set();
    let totalBytes = 0;
    let documentLines = 0;
    for (const entry of files) {
      const relative = typeof entry === 'string' ? entry : entry?.path;
      const membership = typeof entry === 'string' ? 'unverified' : entry?.membership ?? 'unverified';
      const tier = typeof entry === 'string' ? undefined : entry?.tier;
      if (!['verified', 'stale', 'unverified', 'missing'].includes(membership)) return { results: [], diagnostics: ['invalid-membership'] };
      if (membership === 'missing') {
        return { results: [], diagnostics: [`missing-membership:${String(relative ?? '').slice(0, 160)}`] };
      }
      if (typeof relative !== 'string' || !relative || relative.length > 1024 || path.isAbsolute(relative) ||
          path.win32.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '..' || part === '.')) return { results: [], diagnostics: ['invalid-path'] };
      if (seenPaths.has(relative)) continue;
      seenPaths.add(relative);
      const candidate = path.resolve(realRoot, relative);
      if (!inside(realRoot, candidate)) return { results: [], diagnostics: ['scope-escape'] };
      if (!(await noLinks(realRoot, candidate))) return { results: [], diagnostics: ['link-rejected'] };
      let resolved;
      try { resolved = await realpath(candidate); } catch {
        return { results: [], diagnostics: [`missing-source:${relative.slice(0, 160)}`] };
      }
      if (!inside(realRoot, resolved)) return { results: [], diagnostics: ['link-escape'] };
      const bytes = await readBounded(
        resolved,
        Math.min(LIMITS.bytesPerFile, LIMITS.totalBytes - totalBytes),
        { validatePath: () => noLinks(realRoot, resolved) },
      );
      if (!bytes) return { results: [], diagnostics: ['source-read-rejected-or-limit'] };
      totalBytes += bytes.byteLength;
      const text = bytes.toString('utf8');
      if (text.includes('\uFFFD')) return { results: [], diagnostics: ['invalid-text'] };
      if (SENSITIVE.test(text)) {
        diagnostics.push(`sensitive-source:${relative.slice(0, 120)}`);
        continue;
      }
      let lineCount = 1;
      for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10 && ++lineCount + documentLines > LIMITS.lines) {
        return { results: [], diagnostics: ['line-limit'] };
      }
      if (lineCount + documentLines > LIMITS.lines) return { results: [], diagnostics: ['line-limit'] };
      documentLines += lineCount;
      documents.push({ source: relative.replaceAll('\\', '/'), membership, tier: tier ?? inferTier(relative), lines: text.split(/\r?\n/) });
    }
    const rows = [];
    let tokenTotal = 0;
    for (const { source, membership, tier, lines } of documents) {
      if (rows.length + lines.length > LIMITS.lines) return { results: [], diagnostics: ['line-limit'] };
      for (let index = 0; index < lines.length; index++) {
        const text = lines[index].slice(0, LIMITS.lineChars);
        const tokens = tokenize(text).slice(0, LIMITS.lineTokens);
        tokenTotal += tokens.length;
        if (tokenTotal > LIMITS.totalTokens) return { results: [], diagnostics: ['token-limit'] };
        if (tokens.length) rows.push({ source, membership, tier, line: index + 1, text, tokens, frequencies: frequencies(tokens) });
      }
    }
    const avgLength = rows.reduce((sum, row) => sum + row.tokens.length, 0) / (rows.length || 1);
    const documentFrequency = new Map(terms.map((term) => [term, rows.reduce((sum, row) => sum + Number(row.frequencies.has(term)), 0)]));
    const idf = new Map(terms.map((term) => {
      const df = documentFrequency.get(term);
      return [term, Math.log(1 + (rows.length - df + 0.5) / (df + 0.5))];
    }));
    const ranked = rows.map((row) => {
      let score = 0;
      for (const term of terms) {
        const tf = row.frequencies.get(term) ?? 0;
        if (tf) score += (idf.get(term) * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * row.tokens.length / avgLength));
      }
      return { source: row.source, line: row.line, excerpt: row.text.trim().slice(0, LIMITS.excerpt), score: Number(score.toFixed(6)), provenance: 'live-atlas-source-via-curated-mirror-membership', membership: row.membership, membershipFreshness: 'unverified', tier: row.tier ?? null, legacy: row.tier === '08', untrusted: true };
    }).filter((row) => row.score > 0).sort((a, b) =>
      b.score - a.score || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) || a.line - b.line);
    const counts = new Map();
    const balanced = ranked.filter((row) => {
      const count = counts.get(row.source) ?? 0;
      if (count >= 3) return false;
      counts.set(row.source, count + 1);
      return true;
    }).slice(0, limit);
    return { results: balanced, diagnostics: diagnostics.slice(0, LIMITS.files) };
  } catch {
    return { results: [], diagnostics: ['read-failed'] };
  }
}

function frequencies(tokens) {
  const map = new Map();
  for (const token of tokens) map.set(token, (map.get(token) ?? 0) + 1);
  return map;
}

export async function readBounded(file, maxBytes, { openFile = open, validatePath = async () => true } = {}) {
  if (maxBytes < 0) return null;
  let handle;
  let result = null;
  try {
    const pathBefore = await lstat(file);
    if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size > maxBytes) return null;
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await openFile(file, flags);
    const opened = await handle.stat();
    if (!sameFile(pathBefore, opened) || opened.size > maxBytes || !(await validatePath(file))) return null;
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(16_384, maxBytes - size + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) return null;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const pathAfter = await lstat(file);
    if (!sameFile(opened, pathAfter) || pathAfter.isSymbolicLink() || !(await validatePath(file))) return null;
    result = Buffer.concat(chunks, size);
  } catch {
    result = null;
  } finally {
    try { await handle?.close(); } catch { result = null; }
  }
  return result;
}

function sameFile(a, b) {
  return a.isFile() && b.isFile() && Number.isFinite(a.dev) && Number.isFinite(b.dev) &&
    Number.isFinite(a.ino) && Number.isFinite(b.ino) && a.ino > 0 && b.ino > 0 &&
    a.dev === b.dev && a.ino === b.ino;
}

async function noLinks(root, candidate) {
  let current = root;
  for (const part of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
    } catch { return false; }
  }
  return true;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function inferTier(relative) {
  return /(?:^|[\\/])08\s*(?:-|\u2013|\u2014)/u.test(relative) ? '08' : undefined;
}
