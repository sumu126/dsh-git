/**
 * Client check: run the browser half's `apply` for real.
 *
 * The other checks never execute the client entry, so slot registration, the
 * dictionaries, the tab type, and the panel's read path were only ever exercised
 * in a live browser. This mounts the client half against node doubles of the
 * three services it injects, drives the panel's gestures against stubbed routes,
 * and asserts that unloading the owning fiber takes every registration and every
 * pending read with it — the property a hot reload depends on.
 *
 * The harness mounts no DOM: `apply` registers and binds, and the panel's state
 * is driven through its controller, not through React.
 *
 *   npm run verify:client
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { load, resolve } from './css-stub.mjs'

// The component files import their stylesheets, which only the build's CSS
// Modules pipeline can compile. Registering the stub before the client modules
// are imported keeps this check about what `apply` registers.
registerHooks({ resolve, load })

const { apply, inject } = await import('../src/client/index.ts')
const { GIT_TAB_ID, GIT_TAB_KIND, GIT_DIFF_PATH, GIT_LOG_PATH, GIT_REPOS_PATH, GIT_ROOTS_PATH, GIT_STATUS_PATH, GIT_COMMIT_PATH, GIT_STAGE_PATH } = await import('../src/contract.ts')
const { COMMIT_NEEDS_MESSAGE } = await import('../src/client/panel.ts')
const { NS, TOOL_NS, en, toolEn, toolZh, zh } = await import('../src/client/locales.ts')
const { TOOL_ROW_KEYS } = await import('../src/client/card-model.ts')
const { GitIcon } = await import('../src/client/GitPanel.tsx')

/** The translate seat, with `{name}` interpolation. */
function translate(dictionary, key, params) {
  const template = dictionary?.[key]
  if (typeof template !== 'string') throw new Error(`missing copy for "${String(key)}"`)
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
}

/**
 * One fake context carrying the services the client half injects.
 * @param options - the services this shell serves.
 */
function makeContext(options = {}) {
  const services = new Set(options.services ?? ['slots', 'locale', 'sidebarRightTabs'])
  const seats = new Map()
  const dictionaries = new Map()
  const tabTypes = new Map()
  const disposers = []
  let nextSeat = 0

  const effect = (callback) => {
    const disposer = callback()
    if (disposer !== undefined) disposers.push(disposer)
    return () => {}
  }
  const locale = {
    register(ns, dict) {
      dictionaries.set(ns, dict)
      return () => { dictionaries.delete(ns) }
    },
    bind(ns) {
      return (key, params) => translate(dictionaries.get(ns)?.zh ?? zh, key, params)
    },
  }
  const slots = {
    inject(name, callback) {
      effect(() => {
        const owned = []
        const created = callback()
        let generator
        if (created !== null && typeof created === 'object' && typeof created.next === 'function') {
          generator = created
          for (let step = generator.next(); step.done !== true; step = generator.next()) owned.push(step.value)
        } else if (created !== undefined) owned.push(created)
        return () => {
          for (const dispose of owned) dispose()
          generator?.return?.()
        }
      })
      return () => {}
    },
    register(registration, component) {
      const id = nextSeat++
      seats.set(id, { options: registration, component })
      return () => { seats.delete(id) }
    },
  }
  const sidebarRightTabs = {
    register(definition) {
      tabTypes.set(definition.id, definition)
      return () => { tabTypes.delete(definition.id) }
    },
  }
  const ctx = {
    effect,
    locale,
    slots,
    sidebarRightTabs,
    get(name) {
      return services.has(name) ? ctx[name] : undefined
    },
    inject(deps, callback) {
      if (!deps.every(service => services.has(service))) return () => {}
      return effect(() => callback(ctx))
    },
  }
  return {
    ctx,
    seats,
    dictionaries,
    tabTypes,
    async dispose() {
      for (const disposer of [...disposers].reverse()) await disposer?.()
    },
  }
}

/** Let the reads a gesture started land. */
async function settle() {
  for (let attempt = 0; attempt < 6; attempt++) await new Promise(resolve => setTimeout(resolve, 0))
}

// ---- The declared services and the registrations ---------------------------

assert.deepEqual(
  inject,
  ['slots', 'locale', 'sidebarRightTabs'],
  'the client declares the services it reads; no settings transport is required',
)

const harness = makeContext()
apply(harness.ctx)

assert.ok(harness.dictionaries.has(NS), 'the panel namespace registers')
assert.ok(harness.dictionaries.has(TOOL_NS), 'the tool-row namespace registers')
assert.deepEqual(Object.keys(harness.dictionaries.get(NS).zh).sort(), Object.keys(zh).sort(), 'the Chinese panel dictionary is handed over whole')
assert.deepEqual(Object.keys(harness.dictionaries.get(NS).en).sort(), Object.keys(en).sort(), 'and its English counterpart')
assert.deepEqual(Object.keys(harness.dictionaries.get(TOOL_NS).zh).sort(), Object.keys(toolZh).sort(), 'the Chinese tool-row dictionary is handed over whole')
assert.deepEqual(Object.keys(harness.dictionaries.get(TOOL_NS).en).sort(), Object.keys(toolEn).sort(), 'and its English counterpart')
assert.notEqual(zh.guideHint, en.guideHint, 'the two languages are not the same strings')
console.log(`dictionaries: ${String(Object.keys(zh).length)} panel keys and ${String(Object.keys(toolZh).length)} tool-row keys, both languages`)

const seats = () => [...harness.seats.values()]
const body = seats().find(seat => seat.options.name === 'sidebar.right.pane.tab')
const title = seats().find(seat => seat.options.name === 'sidebar.right.pane.tab.title')
assert.ok(body, 'the panel claims a right-sidebar tab body')
assert.ok(title, 'and a chip title seat, so an open chip follows a language switch')
assert.equal(body.options.key, GIT_TAB_ID)
assert.equal(title.options.key, GIT_TAB_ID)
assert.equal(body.options.locale, NS)
assert.equal(typeof body.component, 'function', 'the body is a component')
assert.equal(typeof title.component, 'function')

assert.deepEqual([...harness.tabTypes.keys()], [GIT_TAB_ID], 'one tab type, under the identity the shell dispatches on')
const tabType = harness.tabTypes.get(GIT_TAB_ID)
assert.equal(tabType.kind, GIT_TAB_KIND)
assert.equal(tabType.title(), zh.panelTitle, 'the chip label is translated at use')
assert.equal(tabType.guide.length, 1, 'one guide card, because that is how a page type is opened')
assert.equal(tabType.guide[0].id, GIT_TAB_KIND)
assert.equal(tabType.guide[0].title(), zh.panelTitle)
assert.equal(tabType.guide[0].description(), zh.guideHint)
assert.equal(tabType.guide[0].icon, GitIcon, 'the card carries this plugin\'s own glyph')

const rows = seats().filter(seat => seat.options.name === 'tool.call.toolview')
assert.deepEqual(rows.map(seat => seat.options.key).sort(), [...TOOL_ROW_KEYS].sort(), 'a row is claimed for exactly this plugin\'s tools')
for (const row of rows) {
  assert.equal(row.options.locale, TOOL_NS, `the "${String(row.options.key)}" row resolves its copy from the tool namespace`)
  assert.equal(typeof row.component, 'function', `the "${String(row.options.key)}" row is a component`)
}
console.log(`registered: one "${String(tabType.kind)}" page type with a guide card, and ${String(rows.length)} tool rows`)

// The glyph is drawn here rather than imported from the shell: the shell renamed
// its icon set between generations, and a missing export renders nothing at all.
const glyph = GitIcon({ size: 16 })
assert.equal(typeof glyph, 'object', 'the guide glyph is a rendered element, not undefined')
assert.equal(glyph.type, 'svg')
assert.equal(GitIcon({}).type, 'svg', 'a glyph without a size still draws')
console.log('icon: the guide glyph is this plugin\'s own SVG, so a shell rename cannot blank it')

// ---- The panel's read path ------------------------------------------------

/** One repository summary, as the host writes it. */
const SUMMARY = {
  path: 'C:/ws/work', name: 'work', branch: 'main', detached: false, head: 'abc1234',
  upstream: 'origin/main', ahead: 1, behind: 0, staged: 1, unstaged: 2, untracked: 1, conflicted: 0, dirty: true,
}

/** The history the graph route answers with: a merge with one parent outside it. */
const COMMITS = [
  {
    hash: 'aaaaaaaaaaaaaaaa', short: 'aaaaaaa', author: 'sumu126', email: 's@example.com',
    date: '2026-11-03T11:00:00+08:00', timestamp: 1, subject: 'merge a feature', refs: ['HEAD -> main'],
    parents: ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc'],
  },
  {
    hash: 'bbbbbbbbbbbbbbbb', short: 'bbbbbbb', author: 'sumu126', email: 's@example.com',
    date: '2026-11-03T10:00:00+08:00', timestamp: 0, subject: 'work on main', refs: [],
    parents: [],
  },
  {
    hash: 'cccccccccccccccc', short: 'ccccccc', author: 'sumu126', email: 's@example.com',
    date: '2026-11-03T09:00:00+08:00', timestamp: 0, subject: 'work on the feature', refs: ['feat'],
    parents: [],
  },
]

/** The panel's route answers, keyed by path. */
function answer(path, query) {
  if (path === GIT_ROOTS_PATH) {
    return {
      roots: [{ path: 'C:/ws', title: 'ws', source: 'workspace' }],
      default: 'C:/ws',
      ...omitCapabilities ? {} : { capabilities: { stage: true, commit: true, switch: true } },
    }
  }
  if (path === GIT_REPOS_PATH) {
    return { root: query.root ?? 'C:/ws', repos: [{ ...SUMMARY, path: `${query.root ?? 'C:/ws'}/work` }], truncated: false }
  }
  if (path === GIT_STATUS_PATH) {
    return {
      status: {
        repo: SUMMARY,
        files: [{ path: 'alpha.txt', index: 'M', worktree: 'M', kind: 'changed' }],
        filesTruncated: false,
      },
    }
  }
  if (path === GIT_LOG_PATH) {
    return { repo: SUMMARY, commits: COMMITS }
  }
  if (path === GIT_DIFF_PATH) {
    return {
      diff: {
        repo: SUMMARY, scope: query.scope ?? 'working', files: [{ status: 'M', path: 'alpha.txt' }],
        additions: 1, deletions: 0, patch: '+two\n', truncated: false,
      },
    }
  }
  return undefined
}

/** Every route call this check caused, in order. */
const calls = []
let failing = false
/** When set, the roots answer is the one a host from before `capabilities` sends. */
let omitCapabilities = false

globalThis.window = { location: { origin: 'http://127.0.0.1:3099' } }
globalThis.fetch = async (request, init = {}) => {
  const url = new URL(String(request), 'http://127.0.0.1:3099')
  const query = Object.fromEntries(url.searchParams)
  const method = init.method ?? 'GET'
  const sent = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ path: url.pathname, query, method, body: sent, signal: init.signal })
  if (failing) return new Response('boom', { status: 500 })
  if (method === 'POST') {
    if (url.pathname === GIT_COMMIT_PATH) {
      return Response.json({ status: { repo: SUMMARY, files: [], filesTruncated: false }, commit: COMMITS[0], files: [] })
    }
    if (url.pathname === GIT_STAGE_PATH) {
      return Response.json({ status: { repo: SUMMARY, files: [], filesTruncated: false } })
    }
    return new Response('not stubbed', { status: 404 })
  }
  const body = answer(url.pathname, query)
  return body === undefined ? new Response('not stubbed', { status: 404 }) : Response.json(body)
}

const face = body.options.inject()
assert.equal(typeof face.hooks.gitPanel.getSnapshot, 'function', 'the face carries the panel snapshot')
assert.equal(typeof face.hooks.gitPanel.subscribe, 'function')
assert.equal(typeof face.hooks.gitPanel.set, 'function')
assert.equal(typeof face.hooks.gitPanel.update, 'function')
for (const action of ['refresh', 'chooseRoot', 'select', 'chooseScope']) {
  assert.equal(typeof face.git[action], 'function', `the panel exposes the "${action}" gesture`)
}
await settle()

const state = () => face.hooks.gitPanel.getSnapshot()
assert.equal(state().phase, 'ready')
assert.equal(state().root, 'C:/ws')
assert.deepEqual(state().roots.map(root => root.title), ['ws'])
assert.deepEqual(state().capabilities, { stage: true, commit: true, switch: true }, 'the panel is told what the host allows')
assert.equal(state().repos.length, 1)
assert.equal(state().selected, 'C:/ws/work', 'the first repository is selected, so the panel opens on content')
assert.equal(state().detail.status.repo.name, 'work')
assert.equal(state().detail.diff.scope, 'working')
assert.equal(state().commits.length, 3, 'the graph reads the history as well as the status')
assert.deepEqual(state().commits[0].parents, ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc'], 'the parents a drawing needs reach the panel')
assert.deepEqual(calls.map(call => call.path), [GIT_ROOTS_PATH, GIT_REPOS_PATH, GIT_STATUS_PATH, GIT_DIFF_PATH, GIT_LOG_PATH],
  'the panel reads the roots, the repositories, then the selection\'s status, diff, and history')
console.log(`panel: ${String(state().repos.length)} repository read, selected, described, and graphed`)

/** The last call to one route. */
const lastCall = path => [...calls].reverse().find(call => call.path === path)
assert.equal(lastCall(GIT_LOG_PATH).query.limit, '50', 'the graph opens on the default bound')

face.git.chooseScope('staged')
await settle()
assert.equal(state().scope, 'staged')
assert.equal(state().detail.diff.scope, 'staged')
assert.equal(lastCall(GIT_DIFF_PATH).query.scope, 'staged', 'the scope gesture re-reads the diff it names')
console.log('panel: the scope gesture re-reads the other comparison')

// Re-selecting the same repository keeps the notification quiet but still reads:
// the reader asked for the freshest status, not for a cached one.
face.git.chooseRoot('C:/other')
await settle()
assert.equal(state().root, 'C:/other')
assert.equal(lastCall(GIT_REPOS_PATH).query.root, 'C:/other')
assert.equal(state().selected, 'C:/other/work', 'the selection moves with the root')

const beforeRefresh = calls.length
face.git.refresh()
await settle()
assert.ok(calls.length > beforeRefresh)
assert.equal(calls[beforeRefresh].path, GIT_ROOTS_PATH, 'a refresh re-reads the roots, not only the repositories')
console.log('panel: another root and a refresh are each read from the host')

// ---- The panel's mutations -------------------------------------------------
//
// The commit box and the stage actions are the panel's only writes. They go
// through the host's guarded routes, so what is asserted here is that a gesture
// becomes the right request — the guard itself is the host gate's business.

/** The last POST to one route. */
const lastPost = path => [...calls].reverse().find(call => call.method === 'POST' && call.path === path)

// Staging one path.
const beforeStage = calls.length
face.git.stage('alpha.txt')
await settle()
const stageCall = calls.slice(beforeStage).find(call => call.method === 'POST')
assert.ok(stageCall, 'staging a path posts to the host')
assert.equal(stageCall.path, GIT_STAGE_PATH)
assert.deepEqual(stageCall.body, { repo: 'C:/other/work', mode: 'stage', paths: ['alpha.txt'] })
assert.equal(state().busy, null, 'the panel is idle again after the write')

face.git.unstage('alpha.txt')
await settle()
assert.equal(lastPost(GIT_STAGE_PATH).body.mode, 'unstage')

face.git.stageAll()
await settle()
assert.deepEqual(lastPost(GIT_STAGE_PATH).body, { repo: 'C:/other/work', mode: 'stage', all: true })
console.log('panel: a path, and everything, are staged through the host')

// The commit box: the draft is posted, and a committed message clears it.
const beforeCommit = calls.length
face.git.writeDraft('提交面板里的改动')
assert.equal(state().draft, '提交面板里的改动', 'the box holds what was typed')
face.git.commit(false)
await settle()
const commitCall = calls.slice(beforeCommit).find(call => call.method === 'POST' && call.path === GIT_COMMIT_PATH)
assert.ok(commitCall, 'the commit box posts to the host')
assert.deepEqual(commitCall.body, { repo: 'C:/other/work', message: '提交面板里的改动' })
assert.equal(state().draft, '', 'a committed message clears the box')
assert.equal(state().busy, null)
console.log('panel: the commit box posts the message and clears it')

// An empty message never reaches the host.
const beforeEmpty = calls.length
face.git.writeDraft('   ')
face.git.commit(false)
await settle()
assert.equal(calls.slice(beforeEmpty).filter(call => call.method === 'POST').length, 0, 'an empty message is not sent')
assert.equal(state().actionFailure.message, COMMIT_NEEDS_MESSAGE)
face.git.writeDraft('')
assert.equal(state().actionFailure, null, 'typing again clears the refusal')
console.log('panel: an empty message is refused before it reaches the host')

// Opening a commit reads its patch; closing drops it.
face.git.openCommit('aaaaaaaaaaaaaaaa')
await settle()
const commitDiffCall = lastCall(GIT_DIFF_PATH)
assert.equal(commitDiffCall.query.scope, 'commit')
assert.equal(commitDiffCall.query.ref, 'aaaaaaaaaaaaaaaa')
assert.equal(state().selectedCommit, 'aaaaaaaaaaaaaaaa')
assert.equal(state().commitDiff.scope, 'commit')
face.git.closeCommit()
assert.equal(state().selectedCommit, null)
assert.equal(state().commitDiff, null)
console.log('panel: a commit opens its own patch, and closes again')

// "Load more" asks the host for a larger history.
const beforeMore = calls.length
face.git.loadMore()
await settle()
assert.equal(state().graphLimit, 100)
const grown = calls.slice(beforeMore).find(call => call.path === GIT_LOG_PATH)
assert.equal(grown.query.limit, '100', 'load more raises the bound the graph reads')
console.log('panel: load more reads a longer history')

// A failed read is reported, and the panel stops saying it is loading.
failing = true
face.git.refresh()
await settle()
assert.equal(state().phase, 'failed')
assert.match(state().message, /HTTP 500/u)
console.log(`panel: a failed read says so — ${state().message}`)
failing = false
face.git.refresh()
await settle()
assert.equal(state().phase, 'ready')
assert.equal(state().message, null)

// ---- A host from before the capabilities field -----------------------------
//
// The browser half is served from disk and hot-swaps while the process behind it
// keeps running: a page that refreshed after an update can talk to a host that
// has no commit route and no capabilities in its answer. Reading that as "nothing
// is allowed" is what keeps the panel a panel instead of a stack trace.

omitCapabilities = true
face.git.refresh()
await settle()
assert.equal(state().phase, 'ready', 'the panel still opens against an older host')
assert.deepEqual(state().capabilities, { stage: false, commit: false, switch: false },
  'an older host is read as allowing nothing, which is true: it has no such route')
omitCapabilities = false
face.git.refresh()
await settle()
assert.deepEqual(state().capabilities, { stage: true, commit: true, switch: true }, 'and the newer host is read again')
console.log('panel: a host without the capabilities field is read as read-only, not crashed on')

// ---- Unloading ------------------------------------------------------------

let notifications = 0
const unsubscribe = face.hooks.gitPanel.subscribe(() => { notifications += 1 })
face.git.refresh()
await settle()
assert.ok(notifications > 0, 'a subscribed panel is notified of its own reads')
unsubscribe()
const quiet = notifications
face.git.refresh()
await settle()
assert.equal(notifications, quiet, 'an unsubscribed listener stops hearing about them')

await harness.dispose()
assert.equal(harness.seats.size, 0, 'disposing the fiber removes every slot registration')
assert.equal(harness.dictionaries.size, 0, 'and every dictionary it registered')
assert.equal(harness.tabTypes.size, 0, 'and the tab type the shell dispatches through')
const frozen = state()
face.git.refresh()
await settle()
assert.equal(state(), frozen, 'a disposed panel stops reading and stops publishing')
console.log('disposal: every registration, dictionary, tab type, and pending read is gone')

// A second mount is a clean one: nothing from the first run survives into it.
const second = makeContext()
apply(second.ctx)
const secondBody = [...second.seats.values()].find(seat => seat.options.name === 'sidebar.right.pane.tab')
const secondFace = secondBody.options.inject()
await settle()
assert.equal(secondFace.hooks.gitPanel.getSnapshot().phase, 'ready', 'a remount reads again')
assert.equal([...second.seats.values()].filter(seat => seat.options.name === 'tool.call.toolview').length, TOOL_ROW_KEYS.length)
await second.dispose()
assert.equal(second.seats.size, 0, 'and unloads clean')

// ---- The shipped bundle ----------------------------------------------------
//
// The checks above run the TypeScript sources. What a deployment loads is
// `lib/client.js`: a module-table factory registered on `window.__ModuleLoader__`.
// A banner or footer mistake, or an external that the shell does not seed, would
// leave a bundle that never registers anything — and every check above would
// still pass. So the built artifact is loaded the way the shell loads it, through
// a stand-in module table, and then mounted.

const bundleSource = await import('node:fs').then(fs => fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
let handoff
// The bundle reads `window.location` for its routes, so the stand-in window is
// the one this check already gave it, plus the module table.
const loaderWindow = globalThis.window
loaderWindow.__ModuleLoader__ = {
  load: (entry) => { handoff = entry },
}
// The bundle is a classic script whose body calls the loader, not an ES module.
new Function('window', bundleSource)(loaderWindow)
assert.ok(handoff, 'the bundle announces itself to the module table on load')
assert.equal(handoff.id, 'dsh-git', 'under the package identity the shell dispatches on')
assert.equal(typeof handoff.factory, 'function', 'as a factory, which is what the module table stores')

// The shell seeds React itself — the element runtime and the component APIs —
// so those are the only platform modules this bundle may ask for.
const jsxRuntime = await import('react/jsx-runtime')
const react = await import('react')
const requested = []
const builtModule = handoff.factory((name) => {
  requested.push(name)
  if (name === 'react/jsx-runtime') return jsxRuntime
  if (name === 'react') return react
  throw new Error(`the bundle asked for a platform module the shell does not seed: ${name}`)
})
assert.deepEqual(
  [...new Set(requested)].sort(),
  ['react', 'react/jsx-runtime'],
  'the bundle needs only React from the shell, and not a harness package the page may not have',
)
assert.equal(typeof builtModule.apply, 'function', 'the built module exports apply')
assert.deepEqual(builtModule.inject, ['slots', 'locale', 'sidebarRightTabs'], 'and the same declared services as the source')

const built = makeContext()
builtModule.apply(built.ctx)
const builtBody = [...built.seats.values()].find(seat => seat.options.name === 'sidebar.right.pane.tab')
assert.ok(builtBody, 'the built bundle registers the panel body')
assert.deepEqual([...built.tabTypes.keys()], [GIT_TAB_ID], 'and the tab type')
assert.equal([...built.seats.values()].filter(seat => seat.options.name === 'tool.call.toolview').length, TOOL_ROW_KEYS.length,
  'and one row per git tool')
const builtFace = builtBody.options.inject()
await settle()
const builtState = builtFace.hooks.gitPanel.getSnapshot()
assert.equal(builtState.phase, 'ready', `and its panel reads the host (${builtState.phase}: ${builtState.message ?? ''})`)
await built.dispose()
assert.equal(built.seats.size, 0, 'and unloads clean')
console.log(`bundle: lib/client.js loads through a module table, asks for ${[...new Set(requested)].join(', ')}, and registers the same surface`)

// ---- The declared surface is the activation gate ---------------------------
//
// The three services above are declared, not read optionally: a shell that
// serves none of them never calls `apply` at all, so there is no path where this
// half registers into a context it cannot use. `inject` is asserted at the top of
// this check for exactly that reason — a plugin that waits for a service a shell
// never serves is reported as unactivated, which the desktop turns into a startup
// failure.

console.log('client check passed')
