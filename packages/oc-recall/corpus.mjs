import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

const TIER = /^0[0-8]\s+(?:-|\u2013|\u2014)\s+/u;
const SESSION_TIER = /^09\s+(?:-|\u2013|\u2014)\s+/u;
const SECRET_NAME = /(?:^|[._ -])(secret|credential|password|token|private[-_ ]?key)(?:[._ -]|$)|^\.env/i;
const MAX_MEMBERS = 500;
export const CORPUS_LIMITS = Object.freeze({ depth: 32, directories: 512, entries: 4096 });

/** Membership comes only from the current mirror tree; content always comes from atlas originals. */
export async function approvedCorpus(atlas) {
  const diagnostics = [];
  const files = [];
  try {
    const root = await realpath(atlas);
    if (await hasLinkInPath(path.parse(root).root, root)) return { files: [], diagnostics: ['atlas-link-rejected'], mirror: 'unavailable' };
    const mirror = path.join(root, '.graphify', 'corpus');
    if (!(await safeDirectory(mirror, root))) return { files: [], diagnostics: ['corpus-mirror-missing-or-linked'], mirror: 'missing' };
    const membership = [];
    const walkState = { directories: 0, entries: 0, error: null };
    let mirrorDir;
    try { mirrorDir = await opendir(mirror); } catch { return { files: [], diagnostics: ['corpus-mirror-unreadable'], mirror: 'unavailable' }; }
    if (!(await safeDirectory(mirror, root))) {
      try { await mirrorDir.close(); } catch {}
      return { files: [], diagnostics: ['corpus-mirror-changed-or-linked'], mirror: 'unavailable' };
    }
    try {
    for await (const tier of mirrorDir) {
      if (++walkState.entries > CORPUS_LIMITS.entries) return { files: [], diagnostics: ['corpus-entry-limit'], mirror: 'present', error: 'corpus-entry-limit' };
      if (tier.isSymbolicLink() || !tier.isDirectory() || !(TIER.test(tier.name) || SESSION_TIER.test(tier.name))) continue;
      await walkMirror(path.join(mirror, tier.name), tier.name, membership, diagnostics, walkState, 0, root);
      if (walkState.error) return { files: [], diagnostics: [walkState.error], mirror: 'present', error: walkState.error };
      if (membership.length > MAX_MEMBERS) return { files: [], diagnostics: ['membership-limit'], mirror: 'present' };
    }
    } catch {
      return { files: [], diagnostics: ['corpus-mirror-unreadable'], mirror: 'unavailable', error: 'corpus-mirror-unreadable' };
    }
    const sourceFailures = [];
    for (const rel of membership.sort()) {
      if (SECRET_NAME.test(path.basename(rel))) {
        diagnostics.push(`secret-name-excluded:${rel.slice(0, 120)}`);
        continue;
      }
      const source = path.join(root, ...rel.split('/'));
      if (!(await safeFile(source, root))) {
        const message = `source-missing-or-linked:${rel.slice(0, 120)}`;
        diagnostics.push(message);
        sourceFailures.push(message);
        continue;
      }
      files.push({ path: rel, membership: 'unverified', tier: rel.slice(0, 2) });
    }
    if (sourceFailures.length) return { files: [], diagnostics: diagnostics.slice(0, 100), mirror: 'present', error: 'source-incomplete' };
    return { files, diagnostics: diagnostics.slice(0, 100), mirror: 'present' };
  } catch {
    return { files: [], diagnostics: ['corpus-scan-failed'], mirror: 'unavailable' };
  }
}

async function walkMirror(dir, prefix, out, diagnostics, state, depth, root) {
  if (depth > CORPUS_LIMITS.depth) {
    state.error = 'corpus-depth-limit';
    return;
  }
  if (++state.directories > CORPUS_LIMITS.directories) {
    state.error = 'corpus-directory-limit';
    return;
  }
  if (!(await safeDirectory(dir, root))) {
    state.error = 'mirror-directory-missing-or-linked';
    return;
  }
  let directory;
  try { directory = await opendir(dir); } catch {
    state.error = `mirror-read-failed:${prefix.slice(0, 120)}`;
    return;
  }
  if (!(await safeDirectory(dir, root))) {
    try { await directory.close(); } catch {}
    state.error = 'mirror-directory-changed-or-linked';
    return;
  }
  try {
    for await (const entry of directory) {
    if (++state.entries > CORPUS_LIMITS.entries) {
      state.error = 'corpus-entry-limit';
      return;
    }
    if (entry.isSymbolicLink()) {
      diagnostics.push(`mirror-link-skipped:${`${prefix}/${entry.name}`.slice(0, 120)}`);
      continue;
    }
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await walkMirror(path.join(dir, entry.name), rel, out, diagnostics, state, depth + 1, root);
      if (state.error) return;
    }
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(rel);
      if (out.length > MAX_MEMBERS) return;
    }
  }
  } catch {
    state.error = `mirror-read-failed:${prefix.slice(0, 120)}`;
  }
}

async function safeDirectory(candidate, root) {
  try {
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const actual = await realpath(candidate);
    return within(root, actual) && !(await hasLinkInPath(root, candidate));
  } catch { return false; }
}

async function safeFile(candidate, root) {
  if (path.extname(candidate).toLowerCase() !== '.md' || await hasLinkInPath(root, candidate)) return false;
  try {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    return within(root, await realpath(candidate));
  } catch { return false; }
}

async function hasLinkInPath(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return true;
  let current = root;
  try {
    if ((await lstat(current)).isSymbolicLink()) return true;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) return true;
    }
    return false;
  } catch { return true; }
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
