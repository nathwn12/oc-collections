// The three graph reads, as host tools.
//
// They exist so the injected block can name something that answers. The block
// tells every request the atlas is there; without tools the instruction pointed
// at an MCP this host does not configure.
//
// Every tool is a pure read: open graph.json, answer, return text. No writes,
// no CLI, no network, no rebuild. A failure is a sentence, never a throw.

import path from 'node:path'

import { findNode, neighbors, shortestPath } from './graph.js'

const text = (value) => ({ content: value })
const fail = (message) => ({ content: `error: ${message}` })

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
 * Three tools over one atlas. `load` is passed in so the host decides where the
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
            ...rows.map((row) => `- [${row.distance}] ${row.id}${row.relation ? ` (${row.relation}${row.direction ? `, ${row.direction}` : ''})` : ''}\n  ${row.label}`),
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
  ]
}
