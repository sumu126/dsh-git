/**
 * Card check: what the client's row reads out of one call's metadata.
 *
 * The metadata is written by the host and replayed from a session log, so the
 * row treats every field as suspect: a value this version cannot read must answer
 * null (the generic row takes over), and the text helpers must answer a string
 * for any shape at all. A throw here does not lose one row — the shell catches a
 * crashed slot entry and draws nothing, which empties the whole group of tool
 * calls in the turn.
 *
 *   npm run verify:cards
 */
import assert from 'node:assert/strict'
import {
  TOOL_ROW_KEYS, callText, errorText, gitCardModel, genericText,
} from '../src/client/card-model.ts'

/** A settled call node, as the shell hands one over. */
function settled(meta) {
  return { kind: 'settled', meta, content: [{ type: 'text', text: 'text the model read' }] }
}

/** A call node still running: no result, only the arguments. */
const RUNNING = { args: { repo: 'work', scope: 'working' } }

const STATUS_META = {
  card: 'git',
  variant: 'status',
  repo: 'work',
  path: 'C:/ws/work',
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  staged: 1,
  unstaged: 2,
  untracked: 1,
  conflicted: 0,
  total: 4,
  truncated: false,
  files: [
    { path: 'alpha.txt', index: 'M', worktree: 'M', kind: 'changed' },
    { path: 'renamed file.txt', origPath: 'old.txt', index: 'R', worktree: '.', kind: 'renamed' },
  ],
}

const statusCard = gitCardModel(settled(STATUS_META))
assert.equal(statusCard.kind, 'status')
assert.equal(statusCard.repo, 'work')
assert.equal(statusCard.counts.staged, 1)
assert.equal(statusCard.counts.unstaged, 2)
assert.deepEqual(statusCard.files.map(file => file.letters), ['MM', 'R.'])
assert.deepEqual(statusCard.files[1].origPath, 'old.txt')
console.log('status: a settled call reads back its counts and its changed paths')

const diffCard = gitCardModel(settled({
  card: 'git', variant: 'diff', repo: 'work', scope: 'staged', additions: 12, deletions: 3,
  total: 2, truncated: true, files: [{ status: 'M', path: 'a.txt' }, { status: 'A', path: 'b.txt' }],
}))
assert.equal(diffCard.kind, 'diff')
assert.equal(diffCard.scope, 'staged')
assert.equal(diffCard.additions, 12)
assert.equal(diffCard.files.length, 2)

const logCard = gitCardModel(settled({
  card: 'git', variant: 'log', repo: 'work', total: 2, truncated: false,
  commits: [
    { short: 'abc1234', subject: 'second', author: 'Test', date: '2026-11-03T11:00:00+08:00', refs: ['HEAD -> main'] },
    { short: 'def5678', subject: 'first', author: 'Test', date: '2026-11-03T10:00:00+08:00', refs: [] },
  ],
}))
assert.equal(logCard.kind, 'log')
assert.deepEqual(logCard.commits.map(commit => commit.subject), ['second', 'first'])
assert.deepEqual(logCard.commits[0].refs, ['HEAD -> main'])
console.log('diff and log: their own metadata shapes are read as themselves')

const reposCard = gitCardModel(settled({
  card: 'git', variant: 'repos', root: 'C:/ws', total: 1, truncated: false,
  repos: [{ name: 'work', path: 'C:/ws/work', branch: 'main', ahead: 0, behind: 2, changes: 3 }],
}))
assert.equal(reposCard.kind, 'repos')
assert.equal(reposCard.repos[0].changes, 3)

const branchesCard = gitCardModel(settled({
  card: 'git', variant: 'branches', repo: 'work', current: 'main', total: 2, truncated: false,
  branches: [
    { name: 'main', current: true, local: true, ahead: 0, behind: 0, track: 'tracked' },
    { name: 'old', current: false, local: true, ahead: 0, behind: 0, track: 'gone' },
  ],
}))
assert.equal(branchesCard.current, 'main')
assert.deepEqual(branchesCard.branches.map(branch => branch.track), ['tracked', 'gone'])

const actionCard = gitCardModel(settled({
  card: 'git', variant: 'action', repo: 'work', branch: 'main', truncated: false,
  staged: 2, unstaged: 0, untracked: 1, conflicted: 0, dirty: true,
}))
assert.equal(actionCard.kind, 'action')
assert.equal(actionCard.counts.untracked, 1)
console.log('repos, branches, and the staging answer: each variant keeps its own discriminator')

// ---- Shapes a replayed session may carry ---------------------------------

const foreign = [
  ['no block at all', undefined],
  ['an empty object', {}],
  ['a call still running', RUNNING],
  ['a call with no metadata', { kind: 'settled' }],
  ['metadata that is not an object', { kind: 'settled', meta: 'nope' }],
  ['another plugin\'s card', settled({ card: 'table', columns: [], rows: [], rowCount: 0, truncated: false })],
  ['a variant this version does not know', settled({ card: 'git', variant: 'teleport', truncated: false })],
  ['no truncated flag', settled({ card: 'git', variant: 'status', repo: 'work', files: [] })],
  ['files that are not a list', settled({ ...STATUS_META, files: 'nope' })],
  ['a file with no path', settled({ ...STATUS_META, files: [{ index: 'M', worktree: '.' }] })],
  ['a nested dispatch', { kind: 'settled', parentCallId: 'parent', meta: STATUS_META, content: [] }],
  ['a failed call', { kind: 'settled', isError: true, meta: STATUS_META, content: [] }],
]
for (const [label, block] of foreign) {
  assert.equal(gitCardModel(block), null, `${label}: nothing is drawn by the card`)
}
console.log(`foreign shapes: ${String(foreign.length)} shapes all fall back to the generic row`)

// The text helpers are the row's last line of defence: a string, always.
const textShapes = [undefined, null, {}, RUNNING, { kind: 'settled', content: 'nope' }, { kind: 'settled', content: [null, 3] }]
for (const block of textShapes) {
  assert.equal(typeof callText(block), 'string')
  assert.equal(typeof genericText(block), 'string')
  assert.equal(typeof errorText(block), 'string')
}
assert.equal(callText(RUNNING), '{"repo":"work","scope":"working"}', 'a running call shows the arguments it was given')
assert.equal(
  callText({ kind: 'settled', content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] }),
  'line one\nline two',
)
assert.equal(errorText({ kind: 'settled', isError: true, error: { reason: 'git said no' }, content: [] }), 'git said no')
assert.equal(errorText({ kind: 'settled', isError: true, error: { code: 'TOOL_TIMEOUT' }, content: [] }), 'TOOL_TIMEOUT')
console.log('text: every helper answers a string for every shape, and reads both argument spellings')

// The keys the client claims are the wire names the host registers.
assert.deepEqual([...TOOL_ROW_KEYS], [
  'git_repos', 'git_status', 'git_log', 'git_diff', 'git_show',
  'git_branches', 'git_remotes', 'git_stage', 'git_commit', 'git_switch',
])
console.log(`keys: ${String(TOOL_ROW_KEYS.length)} tool rows, one per git tool`)
console.log('card check passed')
