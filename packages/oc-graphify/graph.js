// Graph reads over graphify's graph.json, with no dependency on graphify.
//
// The file is networkx node-link JSON: { nodes: [{ id, label, community,
// source_file, file_type, ... }], links: [{ source, target, relation }] }.
// Everything here is a pure function over that object, so a test can hand it a
// fixture and the host can hand it the real atlas.
//
// Deliberately absent: `query` parity with the CLI. graphify's query resolves
// seeds with token heuristics (Chinese segmentation, diacritic folding, name
// segments) that are its own; reimplementing them badly would answer
// differently from the tool the user trusts. `search` here is label token
// overlap, and every result says so.

import fs from 'node:fs'

/** Read and index one graph.json. Cost is O(nodes + links), once per file. */
export function readGraph(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const data = JSON.parse(raw)
  const nodes = Array.isArray(data.nodes) ? data.nodes : []
  const links = Array.isArray(data.links) ? data.links : []

  const byId = new Map()
  const adjacency = new Map()
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string') continue
    byId.set(node.id, node)
    adjacency.set(node.id, [])
  }
  for (const link of links) {
    if (!link || typeof link.source !== 'string' || typeof link.target !== 'string') continue
    const out = adjacency.get(link.source)
    const back = adjacency.get(link.target)
    if (out) out.push({ id: link.target, relation: link.relation ?? null })
    if (back) back.push({ id: link.source, relation: link.relation ?? null })
  }

  const communities = new Set()
  for (const node of nodes) {
    if (typeof node.community === 'number') communities.add(node.community)
  }

  return {
    file,
    nodes,
    links,
    byId,
    adjacency,
    communityCount: communities.size || (data.graph?.community_count ?? 0),
    version: data.graph?.graphify_version ?? null,
    directed: data.directed === true,
  }
}

/** One line a reader can use without opening the file. */
export function stats(graph) {
  return {
    nodes: graph.nodes.length,
    edges: graph.links.length,
    communities: graph.communityCount,
    version: graph.version,
    directed: graph.directed,
    file: graph.file,
  }
}

const norm = (value) => String(value ?? '').trim().toLowerCase()

/**
 * Find a node by id, then by exact label, then by substring. Returns
 * { match, candidates }: one exact hit is a match, several near hits are
 * candidates the caller must disambiguate.
 */
export function findNode(graph, query) {
  const needle = norm(query)
  if (!needle) return { match: null, candidates: [] }

  const exactId = graph.byId.get(query)
  if (exactId) return { match: exactId, candidates: [] }

  const byLabel = []
  for (const node of graph.nodes) {
    if (norm(node.label) === needle) byLabel.push(node)
  }
  if (byLabel.length === 1) return { match: byLabel[0], candidates: [] }
  if (byLabel.length > 1) return { match: null, candidates: byLabel }

  const partial = []
  for (const node of graph.nodes) {
    const label = norm(node.label)
    if (label.includes(needle) || norm(node.id).includes(needle)) partial.push(node)
    if (partial.length >= 12) break
  }
  if (partial.length === 1) return { match: partial[0], candidates: [] }
  return { match: null, candidates: partial }
}

/** Breadth-first neighbours up to `depth`, with the relation that got there. */
export function neighbors(graph, id, depth = 1) {
  const start = graph.byId.get(id)
  if (!start) return null
  const seen = new Set([id])
  const rows = []
  let frontier = [id]
  for (let level = 1; level <= Math.max(1, Math.min(depth, 3)); level++) {
    const next = []
    for (const current of frontier) {
      for (const edge of graph.adjacency.get(current) ?? []) {
        if (seen.has(edge.id)) continue
        seen.add(edge.id)
        next.push(edge.id)
        const node = graph.byId.get(edge.id)
        rows.push({ id: edge.id, label: node?.label ?? edge.id, relation: edge.relation, distance: level })
      }
    }
    frontier = next
    if (!frontier.length) break
  }
  return rows
}

/** Shortest undirected path between two ids, as an ordered list. */
export function shortestPath(graph, from, to) {
  if (!graph.byId.has(from) || !graph.byId.has(to)) return null
  if (from === to) return [from]
  const previous = new Map([[from, null]])
  const queue = [from]
  while (queue.length) {
    const current = queue.shift()
    for (const edge of graph.adjacency.get(current) ?? []) {
      if (previous.has(edge.id)) continue
      previous.set(edge.id, current)
      if (edge.id === to) {
        const path = [to]
        let step = current
        while (step !== null) {
          path.unshift(step)
          step = previous.get(step)
        }
        return path
      }
      queue.push(edge.id)
    }
  }
  return null
}

/**
 * The most connected entities, excluding the node kinds graphify excludes:
 * file, concept and json-key nodes accumulate edges mechanically.
 */
export function godNodes(graph, top = 10) {
  const NOISE = new Set(['file', 'concept', 'json_key', 'json'])
  const degree = (id) => (graph.adjacency.get(id) ?? []).length
  const ranked = graph.nodes
    .filter((node) => !NOISE.has(String(node.file_type ?? '').toLowerCase()))
    .map((node) => ({ id: node.id, label: node.label ?? node.id, degree: degree(node.id), community: node.community ?? null }))
    .sort((a, b) => b.degree - a.degree)
  return ranked.slice(0, Math.max(1, Math.min(top, 50)))
}

const tokens = (text) =>
  String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 3)

/**
 * Label-token search followed by a bounded BFS. This is ours, not graphify's:
 * it ranks by how many query tokens a label contains, and says so in the reply.
 */
export function search(graph, question, depth = 1, limit = 8) {
  const wanted = tokens(question)
  if (!wanted.length) return []
  const scored = []
  for (const node of graph.nodes) {
    const label = norm(node.label)
    let score = 0
    for (const token of wanted) if (label.includes(token)) score++
    if (score > 0) scored.push({ node, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const seeds = scored.slice(0, Math.max(1, Math.min(limit, 20)))

  const seen = new Set()
  const rows = []
  for (const { node, score } of seeds) {
    if (seen.has(node.id)) continue
    seen.add(node.id)
    rows.push({ id: node.id, label: node.label ?? node.id, relation: null, distance: 0, score })
    for (const hit of neighbors(graph, node.id, depth) ?? []) {
      if (seen.has(hit.id)) continue
      seen.add(hit.id)
      rows.push({ ...hit, score: 0 })
    }
  }
  return rows
}
