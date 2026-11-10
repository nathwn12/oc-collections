/**
 * oc-graphify - helpers.
 *
 * The plugin's only job is orientation: say where the Atlas graph is, how big
 * it is, whether it still matches HEAD, and which verb answers a question. It
 * does not wrap the CLI, register tools, or touch a command: the MCP owns the
 * read verbs and the CLI owns the writes, and a second surface for either one
 * is duplication that drifts.
 *
 * Everything here is pure except `readGraph` (one file) and `headCommit` (one
 * git call), both of which return null instead of throwing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
    const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...summarize(graph), file, mtime: fs.statSync(file).mtimeMs };
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
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const sha = String(out).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export const short = (sha) => (typeof sha === 'string' && sha.length >= 7 ? sha.slice(0, 7) : null);

/**
 * Ask the vault's own freshness command. It is the single owner of the verdict
 * - tier inputs, lesson-bearing session notes, the semantic seed, and a dirty
 * working tree all feed it - so this plugin reports its answer instead of
 * re-deciding freshness from commit equality, which over-reports stale.
 *
 * Returns { state: 'fresh'|'stale', detail } or null when the tool is missing
 * or fails for a reason that is not a verdict (a broken tool is not a stale
 * graph).
 */
export function askFreshness(atlas, { exec = execFileSync, timeout = 8000 } = {}) {
  const tool = path.join(atlas, '.graphify', 'tools', 'graph-freshness.mjs');
  if (!fs.existsSync(tool)) return null;
  try {
    const out = exec(process.execPath, [tool], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
    const line = String(out).trim().split('\n').filter(Boolean).pop() || '';
    return { state: 'fresh', detail: line.replace(/^graph fresh:\s*/, '') };
  } catch (error) {
    if (error?.status !== 1) return null;
    const text = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
    const first = text.split('\n').filter(Boolean)[0] || 'graph is stale';
    return { state: 'stale', detail: first.replace(/^graph-freshness:\s*/, '') };
  }
}

/** fresh | stale | unknown | missing. Commit equality is the fallback only. */
export function verdict(graph, head, fresh = null) {
  if (!graph) return 'missing';
  if (fresh?.state) return fresh.state;
  if (!graph.commit || !head) return 'unknown';
  return graph.commit === head ? 'fresh' : 'stale';
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
  return `Graph state: unverified - ${graph.commit ? 'HEAD unreadable' : 'the graph carries no build commit'}.`;
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
    'Ask it before grepping: `graph_stats`, `graph_node`, `graph_neighbors`, `graph_path`, `graph_god_nodes`, `graph_query` - this plugin\'s own reads over the same file. `graphify query "<question>"` with cwd = the atlas is the CLI, for when an exact answer matters.',
    'Rebuild with `node .graphify/tools/sync-corpus.mjs` from the atlas; never from the vault root, never a bare `graphify update`.',
    stateLine(graph, head, fresh),
  ].join('\n');
}
