/**
 * Graph layout checks: the lane picture the panel draws from a list of commits.
 *
 * The cases are the ones a commit list actually produces — a straight line, a
 * merge, two tips sharing one base, a window that cuts a line in the middle — and
 * each asserts the picture a reader would expect, not the algorithm's internals.
 *
 *   npm test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GRAPH_COLORS, edgePath, layoutGraph, type GraphCommit } from '../src/client/graph.ts'

/** One commit, with its parents. */
function commit(hash: string, ...parents: string[]): GraphCommit {
  return { hash, parents }
}

/** Lane to x, and row to y, the way the component maps them. */
const x = (lane: number): number => 5 + lane * 12
const y = (row: number): number => row * 46 + 23

test('a straight line keeps one lane', () => {
  const layout = layoutGraph([commit('c', 'b'), commit('b', 'a'), commit('a')])
  assert.deepEqual(layout.nodes.map(node => node.lane), [0, 0, 0])
  assert.equal(layout.laneCount, 1)
  assert.deepEqual(layout.edges.map(edge => [edge.from, edge.to, edge.fromLane, edge.toLane]), [
    ['c', 'b', 0, 0],
    ['b', 'a', 0, 0],
  ])
})

test('a merge draws one edge per parent, and the second parent keeps its own lane', () => {
  const layout = layoutGraph([
    commit('m', 'a', 'b'),
    commit('a', 'r'),
    commit('b', 'r'),
    commit('r'),
  ])
  assert.deepEqual(layout.nodes.map(node => [node.hash, node.lane]), [
    ['m', 0], ['a', 0], ['b', 1], ['r', 0],
  ])
  assert.equal(layout.laneCount, 2)
  assert.deepEqual(
    layout.edges.filter(edge => edge.from === 'm').map(edge => [edge.to, edge.fromLane, edge.toLane]),
    [['a', 0, 0], ['b', 0, 1]],
    'the first parent continues the lane, the second one leaves it',
  )
  assert.deepEqual(
    layout.edges.filter(edge => edge.to === 'r').map(edge => [edge.from, edge.fromLane, edge.toLane]),
    [['a', 0, 0], ['b', 1, 0]],
    'both sides of the branch join the shared base',
  )
})

test('two tips sharing one base each get a lane, and join it', () => {
  const layout = layoutGraph([commit('main', 'base'), commit('feat', 'base'), commit('base')])
  assert.deepEqual(layout.nodes.map(node => [node.hash, node.lane]), [
    ['main', 0], ['feat', 1], ['base', 0],
  ])
  assert.equal(layout.laneCount, 2)
  assert.deepEqual(layout.edges.map(edge => [edge.from, edge.fromLane, edge.toLane]), [
    ['main', 0, 0],
    ['feat', 1, 0],
  ])
})

test('a parent outside the window leaves the picture at the bottom', () => {
  const layout = layoutGraph([commit('c', 'p')])
  assert.equal(layout.edges.length, 1)
  const edge = layout.edges[0]
  assert.ok(edge !== undefined)
  assert.equal(edge.to, 'p')
  assert.equal(edge.toRow, 1, 'the edge ends at the row after the last commit')
  assert.equal(edge.toLane, edge.fromLane, 'in the lane the child holds')
})

test('a root commit has no edge, and an empty list has nothing to draw', () => {
  assert.deepEqual(layoutGraph([commit('only')]).edges, [])
  const empty = layoutGraph([])
  assert.deepEqual(empty.nodes, [])
  assert.deepEqual(empty.edges, [])
  assert.equal(empty.laneCount, 0)
})

test('a lane colour cycles through the palette', () => {
  const commits = [commit('head', 'base'), commit('a', 'base'), commit('b', 'base'), commit('c', 'base'), commit('base')]
  const layout = layoutGraph(commits)
  for (const node of layout.nodes) assert.equal(node.color, node.lane % GRAPH_COLORS)
})

test('an edge draws a straight line within one lane and a curve between two', () => {
  const straight = edgePath({
    from: 'a', to: 'b', fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, color: 0,
  }, x, y)
  assert.equal(straight, 'M 5 23 L 5 69')

  const curve = edgePath({
    from: 'a', to: 'b', fromRow: 0, toRow: 2, fromLane: 0, toLane: 1, color: 0,
  }, x, y)
  assert.match(curve, /^M 5 23 C /u)
  assert.match(curve, / 17 115$/u, 'it arrives at the parent lane and row')
})
