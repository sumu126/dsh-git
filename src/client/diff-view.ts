/**
 * The patch, parsed into the rows a side-by-side or unified view draws.
 *
 * A unified patch is one stream of context, removed, and added lines; a split
 * view needs each removed line paired with the added line that replaced it, on
 * the same row, with both sides' line numbers. That pairing is the whole job of
 * this module, and it is pure: the view chooses how to draw it, the parser
 * decides what is on each side.
 *
 * @module dsh-git/src/client/diff-view
 */

/** What one side of a row is. */
export type DiffLineKind = 'context' | 'add' | 'del' | 'none'

/** One line on one side of a comparison. */
export interface DiffLine {
  /** What the line is, or `none` for the empty half of a row. */
  kind: DiffLineKind
  /** 1-based line number on this side, or null when the half is empty. */
  number: number | null
  /** The line's text, without its `+`, `-`, or space prefix. */
  text: string
}

/** One row of a side-by-side comparison. */
export interface DiffRow {
  /** The old side: a context line, a removed line, or empty. */
  left: DiffLine
  /** The new side: a context line, an added line, or empty. */
  right: DiffLine
}

/** One hunk of a patch, with its `@@` header. */
export interface DiffHunk {
  /** The header line exactly as git printed it. */
  header: string
  /** The rows the hunk covers. */
  rows: DiffRow[]
}

/** A whole patch, hunk by hunk. */
export interface ParsedDiff {
  /** Hunk headers and their rows, in file order. */
  hunks: DiffHunk[]
}

/** An empty half of a row. */
const BLANK: DiffLine = { kind: 'none', number: null, text: '' }

/** The `@@ -a,b +c,d @@` header, whose two numbers are the first line of each side. */
const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u

/**
 * Pair a run of removed lines with the run of added lines that follows it.
 *
 * The pairing is positional: the first removed line sits beside the first added
 * line, and the longer run keeps its remaining lines on its own side. That is the
 * shape a reader expects — a changed line shows old text on the left and new text
 * on the right — without pretending the lines are semantically related.
 * @param removed - the run's removed lines.
 * @param added - the run's added lines.
 * @returns the rows, longest run counted.
 */
function pairRun(removed: readonly DiffLine[], added: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = []
  for (let index = 0; index < Math.max(removed.length, added.length); index++) {
    rows.push({
      left: removed[index] ?? BLANK,
      right: added[index] ?? BLANK,
    })
  }
  return rows
}

/**
 * Parse one file's unified patch.
 *
 * Everything before the first `@@` header is skipped: the caller already knows
 * the path and the totals, and repeating `diff --git`/`index`/`---`/`+++` in a
 * view whose header says the same thing is noise.
 * @param patch - the patch text, as the diff route answered it.
 * @returns the hunks, each with paired rows.
 */
export function parseDiff(patch: string): ParsedDiff {
  const hunks: DiffHunk[] = []
  let hunk: DiffHunk | undefined
  let oldNumber = 0
  let newNumber = 0
  let removed: DiffLine[] = []
  let added: DiffLine[] = []

  const flush = (): void => {
    if (hunk === undefined) return
    hunk.rows.push(...pairRun(removed, added))
    removed = []
    added = []
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      flush()
      const header = HUNK_HEADER.exec(line)
      if (header === null) {
        hunk = undefined
        continue
      }
      hunk = { header: line, rows: [] }
      hunks.push(hunk)
      oldNumber = Number(header[1])
      newNumber = Number(header[2])
      continue
    }
    if (hunk === undefined) continue
    // `\ No newline at end of file` is metadata about the line above, not a line.
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      added.push({ kind: 'add', number: newNumber++, text: line.slice(1) })
      continue
    }
    if (line.startsWith('-')) {
      removed.push({ kind: 'del', number: oldNumber++, text: line.slice(1) })
      continue
    }
    if (line.startsWith(' ')) {
      flush()
      hunk.rows.push({
        left: { kind: 'context', number: oldNumber++, text: line.slice(1) },
        right: { kind: 'context', number: newNumber++, text: line.slice(1) },
      })
    }
    // Anything else (the trailing empty string, a malformed line) closes the run.
    else flush()
  }
  flush()
  return { hunks }
}

/**
 * Count one parsed patch's added and removed lines.
 *
 * The diff route reports its own totals; this is for a caller that holds only the
 * text (a test, or a patch read from somewhere else).
 * @param parsed - the parsed patch.
 * @returns the two counts.
 */
export function countDiff(parsed: ParsedDiff): { additions: number, deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of parsed.hunks) {
    for (const row of hunk.rows) {
      if (row.left.kind === 'del') deletions += 1
      if (row.right.kind === 'add') additions += 1
    }
  }
  return { additions, deletions }
}
