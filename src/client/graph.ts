/**
 * Lane layout for the commit graph the panel draws.
 *
 * The host hands over commits newest first, each with its parent object names;
 * turning that into a picture is a pure problem, so it lives here and is pinned
 * by a unit test instead of by looking at a screenshot. One lane is reserved per
 * line of history that is still waiting for a commit, which is what makes a
 * branch leave its parent's lane and a merge draw two edges from one dot.
 *
 * Nothing here touches the DOM: the component turns nodes and edges into an SVG.
 *
 * @module dsh-git/src/client/graph
 */

/** The commit fields the layout needs. */
export interface GraphCommit {
  /** Full object name. */
  hash: string
  /** Parent object names, first parent first. */
  parents: readonly string[]
}

/** One commit's place in the picture. */
export interface GraphNode {
  /** The commit this node is. */
  hash: string
  /** Lane the dot sits in. */
  lane: number
  /** Palette slot for the lane's line. */
  color: number
  /** Row, counted from the newest commit. */
  row: number
}

/** One edge from a commit to a parent. */
export interface GraphEdge {
  /** The child commit. */
  from: string
  /** The parent commit, or the hash that continues below the window. */
  to: string
  /** Row of the child. */
  fromRow: number
  /** Row of the parent, or the row after the last commit when it is outside. */
  toRow: number
  /** Lane of the child. */
  fromLane: number
  /** Lane of the parent. */
  toLane: number
  /** Palette slot, taken from the child's lane. */
  color: number
}

/** The whole picture. */
export interface GraphLayout {
  /** Dots, in the order the commits arrived. */
  nodes: GraphNode[]
  /** Edges, child first. */
  edges: GraphEdge[]
  /** Lanes the picture uses, so the gutter can be sized. */
  laneCount: number
}

/** Palette slots available to lanes. */
export const GRAPH_COLORS = 8

/**
 * Lay commits out in lanes.
 *
 * A lane is held by the commit it is waiting for. A commit takes the lane that
 * was waiting for it; a commit nobody waits for (a branch tip, or a commit the
 * window cut in the middle of a line) takes a free lane. Its first parent
 * inherits that lane — a straight line — and further parents claim their own,
 * which is what a merge looks like.
 * @param commits - commits newest first, with their parents.
 * @returns the dots, the edges, and how many lanes the picture uses.
 */
export function layoutGraph(commits: readonly GraphCommit[]): GraphLayout {
  const nodes: GraphNode[] = []
  /** The hash each lane waits for, or null for a free lane. */
  const waiting: (string | null)[] = []
  /** The lane each hash ended up in, once it was placed. */
  const laneOf = new Map<string, number>()

  /** First free lane, appending one when every lane is taken. */
  const freeLane = (): number => {
    const free = waiting.indexOf(null)
    if (free !== -1) return free
    waiting.push(null)
    return waiting.length - 1
  }

  for (const [row, commit] of commits.entries()) {
    let lane = waiting.indexOf(commit.hash)
    if (lane === -1) lane = freeLane()
    laneOf.set(commit.hash, lane)
    nodes.push({ hash: commit.hash, lane, color: lane % GRAPH_COLORS, row })
    // The lane's promise is kept by this commit; it is free again until a parent
    // claims it.
    waiting[lane] = null
    const parents = commit.parents
    const first = parents[0]
    if (first !== undefined && first.length > 0) {
      // A parent already awaited elsewhere is not duplicated: the edge bends to
      // the lane that already holds it, which is what a merge into an existing
      // line looks like.
      if (!waiting.includes(first)) waiting[lane] = first
    }
    for (const parent of parents.slice(1)) {
      if (parent.length === 0 || waiting.includes(parent)) continue
      waiting[freeLane()] = parent
    }
    // A lane that waits for nobody at the end of the list is not drawn.
    while (waiting.length > 0 && waiting[waiting.length - 1] === null) waiting.pop()
  }

  const edges: GraphEdge[] = []
  for (const [row, commit] of commits.entries()) {
    const from = nodes[row]
    if (from === undefined) continue
    for (const parent of commit.parents) {
      if (parent.length === 0) continue
      const parentRow = commits.findIndex(candidate => candidate.hash === parent)
      if (parentRow <= row) {
        // The parent continues below the window: the line leaves the picture at
        // the bottom, in the child's own lane.
        edges.push({
          from: commit.hash, to: parent, fromRow: row, toRow: commits.length,
          fromLane: from.lane, toLane: from.lane, color: from.color,
        })
        continue
      }
      const toLane = laneOf.get(parent) ?? from.lane
      edges.push({
        from: commit.hash, to: parent, fromRow: row, toRow: parentRow,
        fromLane: from.lane, toLane, color: from.color,
      })
    }
  }

  const laneCount = nodes.reduce((count, node) => Math.max(count, node.lane + 1), 0)
  return { nodes, edges, laneCount }
}

/**
 * The path one edge draws.
 *
 * A straight drop when both ends share a lane, otherwise a curve that leaves the
 * child downwards and arrives at the parent from above — the shape a reader
 * already knows from every graph view.
 * @param edge - the edge.
 * @param x - lane to x-coordinate.
 * @param y - row to y-coordinate.
 * @returns an SVG path.
 */
export function edgePath(edge: GraphEdge, x: (lane: number) => number, y: (row: number) => number): string {
  const x1 = x(edge.fromLane)
  const y1 = y(edge.fromRow)
  const x2 = x(edge.toLane)
  const y2 = y(edge.toRow)
  if (x1 === x2) return `M ${String(x1)} ${String(y1)} L ${String(x2)} ${String(y2)}`
  const bend = Math.min(24, Math.max(8, (y2 - y1) / 2))
  return `M ${String(x1)} ${String(y1)} C ${String(x1)} ${String(y1 + bend)}, ${String(x2)} ${String(y2 - bend)}, ${String(x2)} ${String(y2)}`
}
