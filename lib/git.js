// Git facts, read-only, no plumbing inventions. Every call fails soft and says so.
import { spawnSync } from 'node:child_process';

export function git(cwd, args, { timeout = 20000 } = {}) {
  const run = spawnSync('git', args, {
    cwd,
    timeout,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (run.error) return { ok: false, code: -1, out: '', err: String(run.error.message || run.error) };
  // Trim only the trailing newline: a leading space is porcelain's status
  // column, and trimming the whole output silently shifts every path by one
  // character on the first line.
  const out = (run.stdout || '').replace(/\s+$/, '');
  const err = (run.stderr || '').trim();
  return { ok: run.status === 0, code: run.status ?? -1, out, err };
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

/** Every path the working tree has touched: modified, staged, deleted, untracked. */
export function changedFiles(cwd, { base = null, includeUntracked = true } = {}) {
  const seen = new Map();

  const add = (file, status) => {
    const key = file.replace(/\\/g, '/');
    const prev = seen.get(key);
    if (!prev) seen.set(key, status);
  };

  const porcelain = git(cwd, ['status', '--porcelain=v1', includeUntracked ? '-uall' : '-uno']);
  if (porcelain.ok) {
    for (const line of porcelain.out.split('\n')) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2).trim() || '?';
      const file = line.slice(3).trim().replace(/^"[.]\//, '').replace(/"$/, '');
      if (file) add(file, code);
    }
  }

  if (base) {
    const diff = git(cwd, ['diff', '--name-only', '--no-renames', `${base}...HEAD`]);
    if (diff.ok) for (const file of diff.out.split('\n')) if (file.trim()) add(file.trim(), 'M');
  }

  return [...seen.entries()].map(([file, status]) => ({ file, status }));
}
