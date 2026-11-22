/**
 * oc-graphify - helpers.
 *
 * The plugin's only job is orientation: say where the Atlas graph is, how big
 * it is, whether it still matches HEAD, and which verb answers a question. It
 * never wraps the CLI and never touches a command: the three reads answer from
 * graph.json, the CLI owns the writes, and GRAPH_REPORT.md owns the hub list.
 *
 * Everything here is pure except `readGraph` (one file), `headCommit` (one git
 * call) and `askFreshness` (one hidden child), all of which return null instead
 * of throwing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { execFile } from 'node:child_process';

/** First line of every injected block; also how a second injection is refused. */
export const MARKER = '<!-- oc-graphify -->';

/**
 * Where the atlas path is recorded. The record lives in the harness config
 * directory, not beside this source: the package is installed into
 * `~/.config/opencode/plugins/` and a copy or a junction must read the same
 * one record. `OC_GRAPHIFY_CONFIG` overrides it for a test or a second host.
 */
export function configPath(env = process.env) {
  const explicit = typeof env?.OC_GRAPHIFY_CONFIG === 'string' ? env.OC_GRAPHIFY_CONFIG.trim() : '';
  if (explicit) return explicit;
  return path.join(os.homedir(), '.config', 'opencode', 'graphify.json');
}

export function readConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const atlas = typeof raw?.atlas === 'string' ? raw.atlas.trim() : '';
    return atlas ? { atlas } : null;
  } catch {
    return null;
  }
}

export function graphFile(atlas) {
  return path.join(atlas, 'graphify-out', 'graph.json');
}

/** Counts from a parsed graph.json. A missing field reads 0, never a throw. */
export function summarize(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const links = Array.isArray(graph?.links) ? graph.links : [];
  const communities = new Set();
  for (const node of nodes) {
    if (node && node.community !== undefined && node.community !== null) communities.add(node.community);
  }
  return {
    nodes: nodes.length,
    edges: links.length,
    communities: communities.size,
    commit: typeof graph?.built_at_commit === 'string' ? graph.built_at_commit : null,
    version: typeof graph?.graph?.graphify_version === 'string' ? graph.graph.graphify_version : null,
  };
}

/** The parsed graph plus the file it came from, or null when there is none. */
export function readGraph(atlas) {
  const file = graphFile(atlas);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const graph = JSON.parse(raw);
    return { ...summarize(graph), file, mtime: fs.statSync(file).mtimeMs, fingerprint: createHash('sha256').update(raw).digest('hex') };
  } catch {
    return null;
  }
}

/** HEAD of the atlas repo, or null when git cannot answer in time. */
export function headCommit(atlas, { exec = execFileSync, timeout = 4000 } = {}) {
  try {
    const out = exec('git', ['-C', atlas, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const sha = String(out).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function headCommitAsync(atlas, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', atlas, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4096,
    }, (error, stdout) => {
      const sha = String(stdout || '').trim();
      resolve(!error && /^[0-9a-f]{40}$/.test(sha) ? sha : null);
    });
  });
}

export const short = (sha) => (typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : null);

/** A real JavaScript runtime; the compiled host's `opencode.exe` is not one. */
const JS_RUNTIME = /^(node|bun)(\.exe)?$/i;

export function isJsRuntime(file) {
  return JS_RUNTIME.test(path.basename(String(file || '')));
}

/**
 * The host is a compiled Bun binary: `process.execPath` is `opencode.exe`, not
 * a JavaScript runtime. Spawning it starts a second OpenCode, which treats the
 * script path as a directory, dies with `ENOTDIR`, and - because the spawn had
 * no `windowsHide` - leaves the console it was given as a dead Windows Terminal
 * window.
 *
 * Resolve a real runtime instead: the host's own `Bun.which`, an explicit
 * `OC_GRAPHIFY_RUNTIME`, or a PATH-resolved `bun`. Never fall back to an
 * executable that is not node or bun; a missing runtime is "unknown", not a
 * stray process.
 */
export function runtimePath({
  execPath = process.execPath,
  env = process.env,
  which = typeof Bun !== 'undefined' && typeof Bun.which === 'function' ? Bun.which.bind(Bun) : null,
} = {}) {
  if (isJsRuntime(execPath)) return execPath;
  const override = typeof env?.OC_GRAPHIFY_RUNTIME === 'string' ? env.OC_GRAPHIFY_RUNTIME.trim() : '';
  if (override) return override;
  if (typeof which === 'function') {
    const found = which('bun') || which('node');
    if (found) return found;
  }
  return 'bun';
}

/**
 * Ask the vault's own freshness command. It is the single owner of the verdict
 * - tier inputs, lesson-bearing session notes, the semantic seed, and a dirty
 * working tree all feed it - so this plugin reports its answer instead of
 * re-deciding freshness from commit equality, which over-reports stale.
 *
 * The child is a real JavaScript runtime, spawned hidden. A missing tool, a
 * non-JS runtime, or a child that fails for a reason other than a verdict all
 * return null: a broken probe is not a stale graph.
 */
export function askFreshness(atlas, { exec = execFileSync, timeout = 8000, runtime = runtimePath() } = {}) {
  const tool = path.join(atlas, '.graphify', 'tools', 'graph-freshness.mjs');
  if (!fs.existsSync(tool) || !isJsRuntime(runtime)) return null;
  try {
    const out = exec(runtime, [tool], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = String(out).trim().split('\n').filter(Boolean).pop() || '';
    return { state: 'fresh', detail: line.replace(/^graph fresh:\s*/, '') };
  } catch (error) {
    if (error?.status !== 1) return null;
    const text = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
    const first = text.split('\n').filter(Boolean)[0] || 'graph is stale';
    return { state: 'stale', detail: first.replace(/^graph-freshness:\s*/, '') };
  }
}

/** Async counterpart for request hooks: bounded child process, never blocks the caller. */
export function askFreshnessAsync(atlas, { timeout = 8000, runtime = runtimePath() } = {}) {
  return new Promise((resolve) => {
    const tool = path.join(atlas, '.graphify', 'tools', 'graph-freshness.mjs');
    if (!fs.existsSync(tool) || !isJsRuntime(runtime)) return resolve(null);
    execFile(runtime, [tool], { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        const line = String(stdout).trim().split('\n').filter(Boolean).pop() || '';
        return resolve({ state: 'fresh', detail: line.replace(/^graph fresh:\s*/, '') });
      }
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.killed) return resolve(null);
      if (error.code !== 1 && error.status !== 1) return resolve(null);
      const text = `${stdout || ''}\n${stderr || ''}`.trim();
      const first = text.split('\n').filter(Boolean)[0] || 'graph is stale';
      resolve({ state: 'stale', detail: first.replace(/^graph-freshness:\s*/, '') });
    });
  });
}

/**
 * Cheap corpus verdict from the build ledger, with no child process and no git.
 * sync-corpus writes `graphify-out/.graphify_build.json` beside the graph: its
 * `stamp` names the build commit and `inputs` maps each corpus input to the
 * sha256 it had at build time. Hashing those files again proves the one claim
 * this plugin makes - the published graph matches the corpus inputs - so a
 * commit that touched no corpus input cannot call a good graph stale. A null
 * means there is no ledger to judge; the hidden child stays the authoritative
 * probe, and the state line reports unverified rather than guessing from HEAD.
 */
export function corpusFreshness(atlas, graph = null, { io = fs } = {}) {
  if (!atlas) return null;
  let ledger;
  try {
    const file = path.join(atlas, 'graphify-out', '.graphify_build.json');
    ledger = JSON.parse(io.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const stamp = typeof ledger?.stamp === 'string' ? ledger.stamp : '';
  const inputs = ledger?.inputs;
  if (!stamp || !inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return null;
  // A ledger left by another build must not certify these graph bytes.
  if (graph?.commit && !String(graph.commit).startsWith(stamp)) return null;
  const entries = Object.entries(inputs);
  if (!entries.length) return null;

  const changed = entries.filter(([rel, recorded]) => {
    let bytes;
    try {
      bytes = io.readFileSync(path.join(atlas, ...String(rel).split('/')));
    } catch {
      return true;
    }
    return createHash('sha256').update(bytes).digest('hex') !== recorded;
  });
  if (changed.length) {
    return { state: 'stale', detail: `${changed.length} corpus input(s) changed since the build` };
  }
  return {
    state: 'fresh',
    detail: 'no corpus input changed; byte integrity verified against the build ledger',
  };
}

/** fresh | stale | unknown | missing. A corpus verdict alone decides freshness. */
export function verdict(graph, head, fresh = null) {
  if (!graph) return 'missing';
  if (fresh?.state === 'fresh' || fresh?.state === 'stale') return fresh.state;
  return 'unknown';
}

/** The last line of the block: the only part allowed to change between turns. */
export function stateLine(graph, head, fresh = null) {
  const state = verdict(graph, head, fresh);
  if (state === 'missing') return 'Graph state: missing - no graph.json; the Atlas has not been built here.';
  if (state === 'fresh') return `Graph state: fresh - ${fresh?.detail || `at ${short(head)}`}.`;
  if (state === 'stale') {
    const why = fresh?.detail || `built ${short(graph.commit)}, HEAD ${short(head)}`;
    return `Graph state: STALE - ${why}. Rebuild before trusting it.`;
  }
  return `Graph state: unverified - ${fresh?.detail || 'no corpus verdict available'}.`;
}

/**
 * The injected block. Everything above the state line is stable for the life of
 * a build, so the prefix caches; the state line is last on purpose.
 */
export function render({ graph, head, atlas, fresh = null }) {
  const where = atlas || '(no atlas recorded in graphify.json)';
  if (!graph) {
    return [
      MARKER,
      `Graphify Atlas: no graph.json under ${where}.`,
      'Graph state: missing - nothing to query until the Atlas is built.',
    ].join('\n');
  }
  const bits = [`${graph.nodes} nodes`, `${graph.edges} edges`, `${graph.communities} communities`];
  if (graph.version) bits.push(`graphify ${graph.version}`);
  return [
    MARKER,
    `Graphify Atlas (durable memory): ${bits.join(', ')}.`,
    `Graph: ${graph.file} - the same graph Obsidian shows as the harness-wiki vault (graph-room).`,
    'Ask it before grepping: `graph_node`, `graph_neighbors`, `graph_path` - this plugin\'s own reads over the same file. Search with `graphify query "<question>"` (cwd = the atlas) when an exact answer matters; the hub list is in `GRAPH_REPORT.md`.',
    'Rebuild with `node .graphify/tools/sync-corpus.mjs` from the atlas; never from the vault root, never a bare `graphify update`.',
    stateLine(graph, head, fresh),
  ].join('\n');
}
