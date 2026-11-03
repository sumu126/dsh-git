/**
 * Diff-view checks: one unified patch becomes paired rows with both line numbers.
 *
 * The pairing is the part a reader notices: a changed line must sit beside the
 * line that replaced it, not two separate runs, and the empty half of an
 * unmatched row must stay empty. These cases pin that, plus the two shapes a real
 * repository produces — a new file and a deletion-only hunk.
 *
 *   npm test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countDiff, parseDiff } from '../src/client/diff-view.ts'

/** One patch with a changed line, an extra added line, and context around it. */
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' line one',
  '-line two',
  '+line two changed',
  '+line two and a half',
  ' line three',
  ' line four',
  '',
].join('\n')

test('a change pairs the removed line with the line that replaced it', () => {
  const parsed = parseDiff(PATCH)
  assert.equal(parsed.hunks.length, 1)
  const hunk = parsed.hunks[0]
  assert.ok(hunk !== undefined)
  assert.equal(hunk.header, '@@ -1,4 +1,5 @@')
  assert.deepEqual(hunk.rows.map(row => [row.left.kind, row.left.number, row.right.kind, row.right.number]), [
    ['context', 1, 'context', 1],
    ['del', 2, 'add', 2],
    ['none', null, 'add', 3],
    ['context', 3, 'context', 4],
    ['context', 4, 'context', 5],
  ])
  assert.equal(hunk.rows[1]?.left.text, 'line two')
  assert.equal(hunk.rows[1]?.right.text, 'line two changed')
  assert.deepEqual(countDiff(parsed), { additions: 2, deletions: 1 })
})

test('the preamble and the no-newline marker are not lines of the file', () => {
  const parsed = parseDiff([
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1 +1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n'))
  const rows = parsed.hunks[0]?.rows ?? []
  assert.equal(rows.length, 1, 'one row, not four')
  assert.deepEqual([rows[0]?.left.kind, rows[0]?.right.kind], ['del', 'add'])
})

test('a new file has no old side', () => {
  const parsed = parseDiff([
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
    '',
  ].join('\n'))
  const rows = parsed.hunks[0]?.rows ?? []
  assert.deepEqual(rows.map(row => [row.left.kind, row.right.number]), [
    ['none', 1],
    ['none', 2],
  ])
  assert.deepEqual(countDiff(parsed), { additions: 2, deletions: 0 })
})

test('a deletion-only hunk leaves the new side empty', () => {
  const parsed = parseDiff([
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-first',
    '-second',
    '',
  ].join('\n'))
  const rows = parsed.hunks[0]?.rows ?? []
  assert.deepEqual(rows.map(row => [row.left.number, row.right.kind]), [
    [1, 'none'],
    [2, 'none'],
  ])
  assert.deepEqual(countDiff(parsed), { additions: 0, deletions: 2 })
})

test('a patch with no hunk has nothing to draw', () => {
  assert.deepEqual(parseDiff(''), { hunks: [] })
  assert.deepEqual(parseDiff('diff --git a/a b/a\nindex 1..2 100644\n'), { hunks: [] })
  assert.deepEqual(countDiff(parseDiff('')), { additions: 0, deletions: 0 })
})
