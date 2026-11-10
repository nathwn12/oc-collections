// The six graph reads, as host tools.
//
// They exist so the injected block can name something that answers. The block
// tells every request the atlas is there; without tools the instruction pointed
// at an MCP this host does not configure.
//
// Every tool is a pure read: open graph.json, answer, return text. No writes,
// no CLI, no network, no rebuild. A failure is a sentence, never a throw.

import path from 'node:path'

import { findNode, godNodes, neighbors, readGraph, search, shortestPath, stats } from './graph.js'

const text = (value) => ({ content: value })
const fail = (message) => ({ content: `error: ${message}` })

const short = (id) => (id.length > 8 ? `${id.slice(0, 8)}…` : id)

function label(node) {
  return node?.label ?? node?.id ?? '(unnamed)'
}

function nodeLine(node, extra = '') {
  const bits = [label(node)]
  if (node.file_type) bits.push(`[${node.file_type}]`)
  if (node.community_name) bits.push(`community: ${node.community_name}`)
  else if (typeof node.community === 'number') bits.push(`community ${node.community}`)
  if (node.source_file) bits.push(node.source_file)
  return `- ${node.id}${extra ? ` ${extra}` : ''}\n  ${bits.join(' · ')}`
}

/**
 * Six tools over one atlas. `load` is passed in so the host decides where the
 * graph is and the tests decide what it is.
 */
export function toolDefinitions({ graphFile, load }) {
  const open = () => {
    try {
      return { graph: load(graphFile) }
    } catch (error) {
      return { error: `cannot read ${path.basename(graphFile)}: ${error.message}` }
    }
  }

  return [
    {
      name: 'graph_stats',
      description:
        'What the atlas holds: node, edge and community counts, the graphify version that built it, and the file it was read from. The first call when you need to know whether the graph is worth querying.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => {
        const { graph, error } = open()
        if (error) return fail(error)
        const s = stats(graph)
        return text(
          [
            `nodes ${s.nodes} · edges ${s.edges} · communities ${s.communities}`,
            `graphify ${s.version ?? 'unknown'} · ${s.directed ? 'directed' : 'undirected'}`,
            s.file,
          ].join('\n'),
        )
      },
    },

    {
      name: 'graph_node',
      description:
        'One node by id, exact label, or a fragment of either. Answers with its type, community, source file and degree. Several near matches are listed as candidates rather than guessed.',
      input: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Node id, label, or a fragment of one.' } },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { graph, error } = open()
        if (error) return fail(error)
        const { match, candidates } = findNode(graph, input.name)
        if (match) {
          const degree = (graph.adjacency.get(match.id) ?? []).length
          return text(`${nodeLine(match, `· degree ${degree}`)}`)
        }
        if (!candidates.length) return text(`no node matches "${input.name}"`)
        return text(
          [
            `${candidates.length} candidate(s) for "${input.name}" - pass an id:`,
            ...candidates.slice(0, 12).map((node) => `- ${node.id}\n  ${label(node)}`),
          ].join('\n'),
        )
      },
    },

    {
      name: 'graph_neighbors',
      description:
        'Everything adjacent to a node, one hop by default, with the relation that connects it. Depth 2 is allowed and costs one more ring.',
      input: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Node id or label.' },
          depth: { type: 'number', description: 'Hops, 1 to 3. Default 1.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { graph, error } = open()
        if (error) return fail(error)
        const { match, candidates } = findNode(graph, input.name)
        if (!match) {
          if (candidates.length) return text(`ambiguous: ${candidates.slice(0, 8).map((n) => n.id).join(', ')}`)
          return text(`no node matches "${input.name}"`)
        }
        const rows = neighbors(graph, match.id, Number(input.depth ?? 1))
        if (!rows.length) return text(`${match.id} has no neighbours`)
        return text(
          [
            `${label(match)} - ${rows.length} neighbour(s):`,
            ...rows.map((row) => `- [${row.distance}] ${row.id}${row.relation ? ` (${row.relation})` : ''}\n  ${row.label}`),
          ].join('\n'),
        )
      },
    },

    {
      name: 'graph_path',
      description:
        'Shortest path between two nodes, as the chain of ids that connects them. Use it to answer "how are these two things related" without reading either file.',
      input: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Start node id or label.' },
          to: { type: 'string', description: 'End node id or label.' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { graph, error } = open()
        if (error) return fail(error)
        const a = findNode(graph, input.from).match
        const b = findNode(graph, input.to).match
        if (!a) return text(`no node matches "${input.from}"`)
        if (!b) return text(`no node matches "${input.to}"`)
        const chain = shortestPath(graph, a.id, b.id)
        if (!chain) return text(`no path between ${a.id} and ${b.id}`)
        return text(
          [
            `${chain.length - 1} step(s):`,
            ...chain.map((id, index) => `${index === 0 ? '  ' : '->'} ${id}`),
          ].join('\n'),
        )
      },
    },

    {
      name: 'graph_god_nodes',
      description:
        'The most connected real entities - the core abstractions. File, concept and json-key nodes are excluded because they accumulate edges mechanically.',
      input: {
        type: 'object',
        properties: { top: { type: 'number', description: 'How many. Default 10, max 50.' } },
        additionalProperties: false,
      },
      execute: async (input) => {
        const { graph, error } = open()
        if (error) return fail(error)
        const rows = godNodes(graph, Number(input.top ?? 10))
        return text(rows.map((row) => `- ${row.degree}  ${row.id}\n  ${row.label}`).join('\n') || 'no nodes')
      },
    },

    {
      name: 'graph_query',
      description:
        'Search labels for the words in a question, then expand one hop around each hit. This is the plugin\'s own search, not graphify\'s CLI heuristic - it matches label tokens, and says so. Use `graphify query` when an exact answer matters.',
      input: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'What you are looking for, in words.' },
          depth: { type: 'number', description: 'Hops around each hit, 0 to 2. Default 1.' },
        },
        required: ['question'],
        additionalProperties: false,
      },
      execute: async (input) => {
        const { graph, error } = open()
        if (error) return fail(error)
        const rows = search(graph, input.question, Number(input.depth ?? 1))
        if (!rows.length) return text(`no label contains the words in "${input.question}"`)
        return text(
          [
            `label-token search (not the CLI's heuristic) - ${rows.length} row(s):`,
            ...rows.map(
              (row) =>
                `- ${short(row.id)}${row.score ? ` score ${row.score}` : ''}${row.distance ? ` +${row.distance}` : ''}\n  ${row.label}`,
            ),
          ].join('\n'),
        )
      },
    },
  ]
}
