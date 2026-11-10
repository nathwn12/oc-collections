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

/**
 * One call for the whole working tree: branch, HEAD, and every touched path.
 * Parsing `status --porcelain=v1 -b -uall` avoids two extra processes for
 * `branch` and `head`, which is the difference between a quiet tool and a
 * visible burst of consoles on Windows.
 */
export function snapshot(cwd) {
  const status = git(cwd, ['status', '--porcelain=v1', '-b', '-uall']);
  if (!status.ok) return { ok: false, branch: null, head: null, files: [] };

  let branchName = null;
  let headSha = null;
  const files = new Map();

  for (const line of status.out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const rest = line.slice(3);
      branchName = rest.split('...')[0].trim();
      continue;
    }
    // `# branch.oid` is only present with --porcelain=v2; v1 keeps it in ## only
    // when unborn. For an unborn branch, HEAD is null and that is honest.
    const code = line.slice(0, 2).trim() || '?';
    const file = line.slice(3).trim().replace(/^"/, '').replace(/"$/, '');
    if (file && !files.has(file)) files.set(file, code);
  }

  const h = git(cwd, ['rev-parse', 'HEAD']);
  headSha = h.ok ? h.out : null;

  return {
    ok: true,
    branch: branchName,
    head: headSha,
    files: [...files.entries()].map(([file, status]) => ({ file, status })),
  };
}

/** Paths touched by commits in `base..HEAD`, not by the working tree. */
export function committedPaths(cwd, base) {
  if (!base) return [];
  const r = git(cwd, ['diff', '--name-only', '--no-renames', `${base}..HEAD`]);
  return r.ok ? r.out.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/** Every path the working tree has touched: modified, staged, deleted, untracked. */
export function changedFiles(cwd, { base = null, includeUntracked = true } = {}) {
  const seen = new Map();

  const map = git(cwd, ['status', '--porcelain=v1', includeUntracked ? '-uall' : '-uno']);
  if (map.ok) {
    for (const line of map.out.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2).trim() || '?';
      const file = line.slice(3).trim().replace(/^"/, '').replace(/"$/, '');
      if (file && !seen.has(file)) seen.set(file, code);
    }
  }

  for (const file of committedPaths(cwd, base)) {
    if (!seen.has(file)) seen.set(file, 'M');
  }

  return [...seen.entries()].map(([file, status]) => ({ file, status }));
}
