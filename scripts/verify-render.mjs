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
const { DiffView, DiffTabTitle } = await import('../src/client/DiffTab.tsx')
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
    reposCollapsed: false,
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
    // The panel never reads navigation params; it only opens tabs from its rows.
    useTabInfo: () => ({ tab: { actions: { openTab: () => {} }, navigation: { params: undefined } } }),
    git: NO_ACTIONS,
  }))
}

/** Render one file's diff, the way its tab draws it. */
function renderDiff(props) {
  return renderToStaticMarkup(createElement(DiffView, { t: translate, ...props }))
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

const brokenHistory = render(snapshot({ commits: [], graphFailure: { kind: 'other', message: 'boom' } }))
assert.match(brokenHistory, /历史读取失败/u, 'a failed history read is reported')

const staleHistory = render(snapshot({ commits: [], graphFailure: { kind: 'stale', message: 'HTTP 404' } }))
assert.match(staleHistory, /重启应用/u, 'a history route the host never registered says what fixes it')

const open = render(snapshot({
  selectedCommit: 'aaaaaaaaaaaaaaaa',
  commitDiff: {
    repo: SUMMARY, scope: 'commit', ref: 'aaaaaaaaaaaaaaaa',
    files: [{ status: 'M', path: 'src/client/GitPanel.tsx' }, { status: 'A', path: 'scripts/verify-client.mjs' }],
    additions: 2, deletions: 0, patch: '+two\n+new\n', truncated: false,
  },
}))
assert.match(open, /GitPanel\.tsx/u, 'an opened commit lists the files it changed')
assert.match(open, /verify-client\.mjs/u)
assert.match(open, /TSX/u, 'each row carries its type badge')
assert.match(open, /src\/client/u, 'and the directory beside the name')
// Inline, not appended after the whole history: the files appear before the next
// commit's subject, which is what makes the expansion belong to its row.
assert.ok(
  open.indexOf('GitPanel.tsx') < open.indexOf('work on main'),
  'the changed files sit inside the list, under the commit they belong to',
)
// The patch is not drawn here: it belongs to the file's own tab.
assert.ok(!open.includes('line two changed'), 'the panel does not inline a patch')

const mergeCommit = render(snapshot({
  selectedCommit: 'aaaaaaaaaaaaaaaa',
  commitDiff: { repo: SUMMARY, scope: 'commit', files: [], additions: 0, deletions: 0, patch: '', truncated: false },
}))
assert.match(mergeCommit, /没有改动路径/u, 'a commit that lists no paths says so')

// ---- The diff tab's picture ----------------------------------------------

const DIFF_PATCH = [
  'diff --git a/src/client/GitPanel.tsx b/src/client/GitPanel.tsx',
  'index 1111111..2222222 100644',
  '--- a/src/client/GitPanel.tsx',
  '+++ b/src/client/GitPanel.tsx',
  '@@ -1,3 +1,4 @@',
  ' export function panel() {',
  '-  return oldValue',
  '+  return newValue',
  '+  // a new line',
  ' }',
  '',
].join('\n')

const diffHtml = renderDiff({
  path: 'src/client/GitPanel.tsx',
  repoName: 'dsh-git',
  label: 'b19d2a8',
  additions: 2,
  deletions: 1,
  patch: DIFF_PATCH,
})
assert.match(diffHtml, /GitPanel\.tsx/u, 'the tab names the file')
assert.equal(count(diffHtml, /class="crumb"/gu), 3, 'the breadcrumb carries the repository and its directories')
assert.match(diffHtml, /<span class="crumb">src<\/span>/u, 'one step per directory')
assert.match(diffHtml, /dsh-git/u, 'the breadcrumb starts at the repository')
assert.match(diffHtml, /›/u, 'and separates its steps')
assert.match(diffHtml, /b19d2a8/u, 'the header says what it is compared against')
assert.match(diffHtml, /TSX/u, 'and the type badge')
assert.match(diffHtml, /\+2/u, 'with the line totals')
assert.match(diffHtml, /−1/u)
assert.match(diffHtml, /并排/u, 'side by side is the default layout')
assert.match(diffHtml, /统一/u, 'and the unified layout is one click away')
assert.match(diffHtml, /@@ -1,3 \+1,4 @@/u, 'the hunk header is shown')
assert.match(diffHtml, /oldValue/u, 'the removed line is there')
assert.match(diffHtml, /newValue/u, 'the added line is there')
// The change is marked inside the line: only the word that changed is tinted.
assert.equal(count(diffHtml, /class="changedDel"/gu), 1, 'one changed word on the old side')
assert.equal(count(diffHtml, /class="changedAdd"/gu), 1, 'and one on the new side')
assert.match(diffHtml, /<span class="changedDel">oldValue<\/span>/u, 'the whole-word change is marked on the left')
assert.match(diffHtml, /<span class="changedAdd">newValue<\/span>/u, 'and on the right')
assert.equal(count(diffHtml, /class="splitRow"/gu), 4, 'four side-by-side rows: context, change, extra add, context')
assert.equal(count(diffHtml, /class="cell del"/gu), 1, 'one removed cell')
assert.equal(count(diffHtml, /class="cell add"/gu), 2, 'two added cells')
console.log(`render: the diff tab draws ${String(count(diffHtml, /class="splitRow"/gu))} rows side by side, with the changed words marked`)

const emptyDiff = renderDiff({ path: 'a.txt', additions: 0, deletions: 0, patch: '' })
assert.match(emptyDiff, /没有改动/u, 'a patch with no hunk says so')

// The tab's chip: the file's name and what it is compared against.
const title = renderToStaticMarkup(createElement(DiffTabTitle, {
  t: translate,
  useTabInfo: () => ({ tab: { navigation: { params: { repo: 'C:/ws/work', path: 'src/client/index.ts', scope: 'commit', ref: 'b19d2a8deadbeef' } } } }),
}))
assert.equal(title, 'index.ts (b19d2a8)', 'the chip names the file and the version')

// ---- The repository list folds -------------------------------------------

const SECOND = { ...SUMMARY, name: 'second-repo', path: 'C:/ws/second-repo' }
const expanded = render(snapshot({ repos: [SUMMARY, SECOND] }))
assert.match(expanded, /second-repo/u, 'the list shows every repository when it is open')
const folded = render(snapshot({ repos: [SUMMARY, SECOND], reposCollapsed: true }))
assert.ok(!/second-repo/u.test(folded), 'a folded list shows only the selection')
assert.match(folded, /work/u, 'which is still there, with its branch')

const committing = render(snapshot({ busy: 'commit', draft: 'a message' }))
assert.match(committing, /提交中/u, 'a commit in flight says so')
assert.match(committing, /disabled/u, 'and its button is disabled')

// A snapshot from a host that predates the capabilities field: the page must draw
// a read-only panel rather than crash on an absent object.
const older = render(snapshot({ capabilities: undefined }))
assert.ok(!/Ctrl\+Enter/u.test(older), 'a snapshot without capabilities renders no commit box')
assert.match(older, /图形/u, 'and still draws the history')
console.log('render: empty history, a stale host, a failed read, an open commit, a commit in flight, and an older host all render')

console.log('render check passed')
