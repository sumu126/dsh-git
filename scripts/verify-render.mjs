/**
 * Render check: the panel, actually rendered.
 *
 * Every other client check runs registration and state; none of them mounts a
 * component. That gap is not theoretical: a missing icon export, a hook used
 * outside its slot, or a field read off an absent object crashes the render and
 * leaves the shell drawing nothing — with every other gate green. So this renders
 * the panel to static markup with fixture state and asserts the picture a reader
 * gets: the commit box, the changed paths with their stage actions, and the graph
 * with one dot per commit and an edge per parent.
 *
 *   npm run verify:render
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { load, resolve } from './css-stub.mjs'

// The component imports its stylesheet; only the build's CSS Modules pipeline can
// compile it, and this check is about markup, not class names.
registerHooks({ resolve, load })

const { createElement } = await import('react')
const { renderToStaticMarkup } = await import('react-dom/server')
const { GitPanel } = await import('../src/client/GitPanel.tsx')
const { zh } = await import('../src/client/locales.ts')

/** The translate seat, with `{name}` interpolation. */
function translate(key, params) {
  const template = zh[key]
  if (typeof template !== 'string') throw new Error(`missing copy for "${String(key)}"`)
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
}

/** One repository summary, as the host writes it. */
const SUMMARY = {
  path: 'C:/ws/work', name: 'work', branch: 'main', detached: false, head: 'aaaaaaa',
  upstream: 'origin/main', ahead: 1, behind: 0, staged: 1, unstaged: 1, untracked: 1, conflicted: 0, dirty: true,
}

/** A merge whose second parent is inside the window, and a root below them. */
const COMMITS = [
  {
    hash: 'aaaaaaaaaaaaaaaa', short: 'aaaaaaa', author: 'sumu126', email: 's@example.com',
    date: '2026-11-03T11:00:00+08:00', timestamp: 3, subject: 'merge a feature',
    refs: ['HEAD -> main'], parents: ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc'],
  },
  {
    hash: 'bbbbbbbbbbbbbbbb', short: 'bbbbbbb', author: 'sumu126', email: 's@example.com',
    date: '2026-11-03T10:00:00+08:00', timestamp: 2, subject: 'work on main',
    refs: [], parents: ['dddddddddddddddd'],
  },
  {
    hash: 'cccccccccccccccc', short: 'ccccccc', author: 'sumu126', email: 's@example.com',
    date: '2026-11-03T09:00:00+08:00', timestamp: 1, subject: 'work on the feature',
    refs: ['tag: v1'], parents: ['dddddddddddddddd'],
  },
  {
    hash: 'dddddddddddddddd', short: 'ddddddd', author: 'sumu126', email: 's@example.com',
    date: '2026-11-02T09:00:00+08:00', timestamp: 0, subject: 'base',
    refs: [], parents: [],
  },
]

/** The repository's status. */
const STATUS = {
  repo: SUMMARY,
  files: [
    { path: 'alpha.txt', index: 'M', worktree: 'M', kind: 'changed' },
    { path: 'brand new.txt', index: '.', worktree: '?', kind: 'untracked' },
  ],
  filesTruncated: false,
}

/** The diff on screen. */
const DIFF = {
  repo: SUMMARY, scope: 'working', files: [{ status: 'M', path: 'alpha.txt' }],
  additions: 1, deletions: 0, patch: '+two\n', truncated: false,
}

/** The whole snapshot, with one field replaced per check. */
function snapshot(overrides = {}) {
  return {
    phase: 'ready',
    roots: [{ path: 'C:/ws', title: 'ws', source: 'workspace' }],
    root: 'C:/ws',
    capabilities: { stage: true, commit: true, switch: true },
    repos: [SUMMARY],
    truncated: false,
    selected: SUMMARY.path,
    detail: { status: STATUS, diff: DIFF, message: null, loading: false },
    scope: 'working',
    message: null,
    commits: COMMITS,
    graphLimit: 50,
    graphFailure: null,
    draft: '',
    busy: null,
    actionFailure: null,
    selectedCommit: null,
    commitDiff: null,
    commitLoading: false,
    ...overrides,
  }
}

/** Every gesture does nothing here; the markup is what this check is about. */
const NO_ACTIONS = new Proxy({}, { get: () => () => {} })

/** Render the panel with one snapshot. */
function render(state) {
  return renderToStaticMarkup(createElement(GitPanel, {
    t: translate,
    useGitPanel: selector => selector(state),
    git: NO_ACTIONS,
  }))
}

/** Count one pattern's matches in some markup. */
const count = (html, pattern) => (html.match(pattern) ?? []).length

// ---- The page a reader gets ----------------------------------------------

const html = render(snapshot())
assert.ok(html.length > 0, 'the panel renders something')
assert.match(html, /Ctrl\+Enter/u, 'the commit box is there, with its placeholder')
assert.match(html, /提交/u, 'and its button')
assert.match(html, /更改/u, 'the changed paths are there')
assert.match(html, /图形/u, 'the graph is there')
assert.match(html, /merge a feature/u, 'with a commit subject')
assert.match(html, /work on the feature/u)
assert.match(html, /sumu126/u, 'and its author')
assert.match(html, /alpha\.txt/u, 'the changed path is listed')
assert.match(html, /brand new\.txt/u, 'the untracked path too')
assert.match(html, /title="暂存"/u, 'an untracked path offers to be staged')
assert.match(html, /title="取消暂存"/u, 'a staged path offers to be unstaged')
assert.match(html, /main/u, 'the HEAD ref is drawn as a chip')

// The graph is geometry, so it is asserted as geometry: one dot per commit, and
// an edge for every parent that is inside the window.
assert.equal(count(html, /<circle/gu), COMMITS.length, 'one dot per commit')
assert.equal(count(html, /<path/gu), 4, 'two parents for the merge, one for each of the other two commits')
assert.ok(/<svg/u.test(html), 'the lines are drawn as SVG')
console.log(`render: ${String(COMMITS.length)} commits drawn, ${String(count(html, /<path/gu))} edges, ${String(count(html, /<circle/gu))} dots`)

// No value the panel could not resolve may reach the markup.
assert.ok(!/NaN|undefined|\[object Object\]/u.test(html), 'no unresolved value is rendered as text')

// ---- A deployment that allows only reads ---------------------------------

const readOnly = render(snapshot({ capabilities: { stage: false, commit: false, switch: false } }))
assert.ok(!/Ctrl\+Enter/u.test(readOnly), 'no commit box is offered when committing is off')
assert.ok(!/title="暂存"/u.test(readOnly), 'no stage action is offered when staging is off')
assert.match(readOnly, /图形/u, 'the history is still drawn')
console.log('render: a read-only deployment gets no commit box and no stage actions')

// ---- Refusals and empty states -------------------------------------------

const empty = render(snapshot({ commits: [] }))
assert.match(empty, /还没有提交/u, 'an empty history says so instead of drawing nothing')

const stale = render(snapshot({ actionFailure: { kind: 'stale', message: 'HTTP 404' } }))
assert.match(stale, /重启应用/u, 'a stale host is reported as the restart it needs')

const brokenHistory = render(snapshot({ commits: [], graphFailure: 'boom' }))
assert.match(brokenHistory, /历史读取失败/u, 'a failed history read is reported')

const open = render(snapshot({ selectedCommit: 'aaaaaaaaaaaaaaaa', commitDiff: DIFF }))
assert.match(open, /这次提交的改动/u, 'an opened commit shows its own patch')
assert.match(open, /\+two/u, 'and the patch text is there')

const committing = render(snapshot({ busy: 'commit', draft: 'a message' }))
assert.match(committing, /提交中/u, 'a commit in flight says so')
assert.match(committing, /disabled/u, 'and its button is disabled')
console.log('render: empty history, a stale host, a failed read, an open commit, and a commit in flight all render')

console.log('render check passed')
