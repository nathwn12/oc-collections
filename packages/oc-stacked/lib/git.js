// Git facts, read-only, no plumbing inventions. Every call fails soft and says so.
// Two processes maximum per tool call: one for HEAD, one for status or diff.
import { run } from './exec.js';

export function git(cwd, args, { timeout = 20000 } = {}) {
  const r = run('git', args, { cwd, timeout });
  return { ok: r.ok, code: r.code, out: r.out, err: r.err };
}

export function isRepo(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}

export function head(cwd) {
  const r = git(cwd, ['rev-parse', 'HEAD']);
  return r.ok ? r.out : null;
}

export function branch(cwd) {
  const r = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.out : null;
}

export function root(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.out : cwd;
}

/** A branch header we can name, or null when there is no commit to be on. */
function parseBranch(rest) {
  const name = rest.replace(/\r?\n$/, '').split('...')[0].trim();
  if (!name) return null;
  if (/^no commits yet on /i.test(name)) return null;
  if (name === 'HEAD (no branch)') return null;
  return name;
}

/**
 * Parse `git status --porcelain=v1 -z` (optionally `-b`).
 *
 * NUL separators mean a path is never quoted and never octal-escaped, so UTF-8
 * comes through intact. A rename or copy is one record carrying TWO paths
 * (destination then source); reading only the first loses the new name, which is
 * exactly how a created file can hide from `scope`.
 */
function parsePorcelain(out) {
  const fields = String(out).split('\0');
  const files = new Map();
  let branchName = null;

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (!field) continue;
    const header = field.replace(/\r?\n$/, '');
    if (header.startsWith('## ')) {
      branchName = parseBranch(header.slice(3));
      continue;
    }
    if (field.length < 3) continue;
    const code = field.slice(0, 2);
    const file = field.slice(3);
    if (!file) continue;
    const status = code.trim() || '?';
    if (!files.has(file)) files.set(file, status);

    if (/[RC]/.test(code)) {
      const other = fields[i + 1];
      if (other) {
        if (!files.has(other)) files.set(other, status);
        i += 1;
      }
    }
  }

  return { branchName, files };
}

/**
 * One call for the whole working tree: branch, HEAD, and every touched path.
 * Parsing `status --porcelain=v1 -z -b -uall` avoids two extra processes for
 * `branch` and `head`, which is the difference between a quiet tool and a
 * visible burst of consoles on Windows.
 */
export function snapshot(cwd) {
  const status = git(cwd, ['status', '--porcelain=v1', '-z', '-b', '-uall']);
  if (!status.ok) return { ok: false, branch: null, head: null, files: [] };

  const { branchName, files } = parsePorcelain(status.out);

  const h = git(cwd, ['rev-parse', 'HEAD']);

  return {
    ok: true,
    branch: branchName,
    head: h.ok ? h.out : null,
    files: [...files.entries()].map(([file, status]) => ({ file, status })),
  };
}

/**
 * Every path named by a commit in `base..HEAD`, including a file that was added
 * and then deleted inside the range. `null` when git cannot answer: "no change"
 * and "could not read" must never look the same to a gate.
 *
 * `git log --name-only` walks the commits one by one, so the two-endpoint diff
 * cannot hide a path that no longer exists at HEAD.
 */
export function committedPaths(cwd, base) {
  if (!base) return null;
  const r = git(cwd, ['log', '--name-only', '--no-renames', '--pretty=format:', `${base}..HEAD`]);
  if (!r.ok) return null;
  return [...new Set(r.out.split('\n').map((s) => s.trim()).filter(Boolean))];
}

/** Every path the working tree has touched: modified, staged, deleted, untracked. */
export function changedFiles(cwd, { base = null, includeUntracked = true } = {}) {
  const seen = new Map();

  const map = git(cwd, ['status', '--porcelain=v1', '-z', includeUntracked ? '-uall' : '-uno']);
  if (map.ok) {
    for (const [file, status] of parsePorcelain(map.out).files) {
      if (!seen.has(file)) seen.set(file, status);
    }
  }

  for (const file of committedPaths(cwd, base) || []) {
    if (!seen.has(file)) seen.set(file, 'M');
  }

  return [...seen.entries()].map(([file, status]) => ({ file, status }));
}
