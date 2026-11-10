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

/** fresh | stale | unknown | missing. The same verdict graph_stats prints. */
export function verdict(graph, head) {
  if (!graph) return 'missing';
  if (!graph.commit || !head) return 'unknown';
  return graph.commit === head ? 'fresh' : 'stale';
}

/** The last line of the block: the only part allowed to change between turns. */
export function stateLine(graph, head) {
  const state = verdict(graph, head);
  if (state === 'missing') return 'Graph state: missing - no graph.json; the Atlas has not been built here.';
  if (state === 'fresh') return `Graph state: fresh at ${short(head)}.`;
  if (state === 'stale') {
    return `Graph state: STALE - built ${short(graph.commit)}, HEAD ${short(head)}. Rebuild before trusting it.`;
  }
  return `Graph state: unverified - ${graph.commit ? 'HEAD unreadable' : 'the graph carries no build commit'}.`;
}

/**
 * The injected block. Everything above the state line is stable for the life of
 * a build, so the prefix caches; the state line is last on purpose.
 */
export function render({ graph, head, atlas }) {
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
    'Ask it before grepping: MCP `graphify` (graph_stats, query_graph, get_node, get_neighbors, get_community, god_nodes, shortest_path), or `graphify query "<question>"` with cwd = the atlas.',
    'Rebuild with `node .graphify/tools/sync-corpus.mjs` from the atlas; never from the vault root, never a bare `graphify update`.',
    stateLine(graph, head),
  ].join('\n');
}
