// The graph reads, against a fixture small enough to reason about.
//
// The fixture is the shape graphify writes: nodes carry id/label/file_type/
// community/source_file, links carry source/target/relation. Nothing here
// touches the real atlas, so the suite runs on a clean machine.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { findNode, neighbors, readGraph, shortestPath } from '../graph.js'
import { toolDefinitions } from '../tools.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-graphify-graph-'))

const FIXTURE = {
  directed: true,
  multigraph: false,
  graph: { graphify_version: '9.9.9' },
  nodes: [
    { id: 'hub', label: 'The Hub', file_type: 'note', community: 1, community_name: 'Core' },
    { id: 'a', label: 'Alpha', file_type: 'note', community: 1 },
    { id: 'b', label: 'Beta', file_type: 'note', community: 2 },
    { id: 'c', label: 'Gamma', file_type: 'note', community: 2 },
    { id: 'f', label: 'file.md', file_type: 'file', community: 2 },
    { id: 'concept', label: 'A Concept', file_type: 'concept', community: 1 },
  ],
  links: [
    { source: 'hub', target: 'a', relation: 'references' },
    { source: 'hub', target: 'b', relation: 'references' },
    { source: 'a', target: 'c', relation: 'rationale_for' },
    { source: 'f', target: 'a', relation: 'contains' },
    { source: 'concept', target: 'b', relation: 'conceptually_related_to' },
  ],
}

const file = path.join(dir, 'graph.json')
fs.writeFileSync(file, JSON.stringify(FIXTURE))

const graph = readGraph(file)

test('readGraph: indexes nodes, links, adjacency and communities', () => {
  assert.equal(graph.nodes.length, 6)
  assert.equal(graph.links.length, 5)
  assert.equal(graph.byId.get('hub').label, 'The Hub')
  assert.equal(graph.adjacency.get('a').length, 1) // directed outgoing edge only
  assert.equal(graph.communityCount, 2)
  assert.equal(graph.version, '9.9.9')
  assert.equal(graph.directed, true)
})

test('findNode: id first, then exact label, then candidates', () => {
  assert.equal(findNode(graph, 'hub').match.id, 'hub')
  assert.equal(findNode(graph, 'a').match.id, 'a', 'an exact id wins before any label search')
  assert.equal(findNode(graph, 'alpha').match.id, 'a') // label is case-insensitive
  const many = findNode(graph, 'e')
  assert.equal(many.match, null)
  assert.ok(many.candidates.length > 1, 'a fragment with several hits returns candidates, never a guess')
  assert.equal(findNode(graph, 'ub').match.id, 'hub', 'a single fragment hit is a match')
  assert.equal(findNode(graph, 'nothing-here').candidates.length, 0)
})

test('neighbors: one hop by default, depth grows the ring', () => {
  const one = neighbors(graph, 'hub', 1)
  assert.deepEqual(one.map((r) => r.id).sort(), ['a', 'b'])
  const two = neighbors(graph, 'hub', 2)
  assert.ok(two.some((r) => r.id === 'c'), 'two hops reaches gamma through alpha')
  assert.equal(neighbors(graph, 'missing', 1), null)
})

test('shortestPath: the chain, or null when disconnected', () => {
  assert.deepEqual(shortestPath(graph, 'hub', 'c'), ['hub', 'a', 'c'])
  assert.deepEqual(shortestPath(graph, 'hub', 'hub'), ['hub'])
  assert.equal(shortestPath(graph, 'hub', 'missing'), null)
})

test('tools: three reads, each answering text, none throwing on a bad file', async () => {
  const defs = toolDefinitions({ graphFile: file, load: readGraph })
  const names = defs.map((d) => d.name).sort()
  assert.deepEqual(names, ['graph_neighbors', 'graph_node', 'graph_path'])
  for (const removed of ['graph_stats', 'graph_god_nodes', 'graph_query']) {
    assert.ok(!names.includes(removed), `${removed} is still registered`)
  }

  const call = async (name, input = {}) => {
    const def = defs.find((d) => d.name === name)
    const result = await def.execute(input)
    assert.equal(typeof result.content, 'string')
    return result.content
  }

  assert.match(await call('graph_node', { name: 'alpha' }), /Alpha/)
  assert.match(await call('graph_neighbors', { name: 'hub' }), /2 neighbour/)
  assert.match(await call('graph_path', { from: 'hub', to: 'c' }), /2 step/)
})

test('tools: a missing graph is a sentence, not an exception', async () => {
  const defs = toolDefinitions({ graphFile: path.join(dir, 'nope.json'), load: readGraph })
  const result = await defs[0].execute({})
  assert.match(result.content, /^error: cannot read nope\.json/)
})

test('directed edges retain source orientation for adjacency, neighbours and paths', () => {
  assert.deepEqual(graph.adjacency.get('hub').map((edge) => edge.id), ['a', 'b'])
  assert.deepEqual(neighbors(graph, 'a', 1).map((row) => row.id), ['c'])
  assert.equal(shortestPath(graph, 'a', 'hub'), null)
  assert.deepEqual(shortestPath(graph, 'hub', 'c'), ['hub', 'a', 'c'])
})

test('undirected graphs expose each edge from either endpoint', () => {
  const undirected = readGraph(writeFixture({ directed: false, links: [{ source: 'a', target: 'b', relation: 'connects' }] }))
  assert.deepEqual(neighbors(undirected, 'a').map((row) => row.id), ['b'])
  assert.deepEqual(neighbors(undirected, 'b').map((row) => row.id), ['a'])
  assert.deepEqual(shortestPath(undirected, 'b', 'a'), ['b', 'a'])
})

function writeFixture(value) {
  const file = path.join(dir, `fixture-${Math.random()}.json`)
  fs.writeFileSync(file, JSON.stringify({ ...FIXTURE, ...value, nodes: [{ id: 'a' }, { id: 'b' }] }))
  return file
}
