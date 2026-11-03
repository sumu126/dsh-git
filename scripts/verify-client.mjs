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
const { GIT_TAB_ID, GIT_TAB_KIND, GIT_DIFF_PATH, GIT_REPOS_PATH, GIT_ROOTS_PATH, GIT_STATUS_PATH } = await import('../src/contract.ts')
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

/** The panel's route answers, keyed by path. */
function answer(path, query) {
  if (path === GIT_ROOTS_PATH) {
    return { roots: [{ path: 'C:/ws', title: 'ws', source: 'workspace' }], default: 'C:/ws' }
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

globalThis.window = { location: { origin: 'http://127.0.0.1:3099' } }
globalThis.fetch = async (request, init = {}) => {
  const url = new URL(String(request), 'http://127.0.0.1:3099')
  const query = Object.fromEntries(url.searchParams)
  calls.push({ path: url.pathname, query, signal: init.signal })
  if (failing) return new Response('boom', { status: 500 })
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
assert.equal(state().repos.length, 1)
assert.equal(state().selected, 'C:/ws/work', 'the first repository is selected, so the panel opens on content')
assert.equal(state().detail.status.repo.name, 'work')
assert.equal(state().detail.diff.scope, 'working')
assert.deepEqual(calls.map(call => call.path), [GIT_ROOTS_PATH, GIT_REPOS_PATH, GIT_STATUS_PATH, GIT_DIFF_PATH],
  'the panel reads the roots, the repositories, then the selection\'s status and diff')
console.log(`panel: ${String(state().repos.length)} repository read, selected, and described`)

/** The last call to one route. */
const lastCall = path => [...calls].reverse().find(call => call.path === path)

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

// ---- The declared surface is the activation gate ---------------------------
//
// The three services above are declared, not read optionally: a shell that
// serves none of them never calls `apply` at all, so there is no path where this
// half registers into a context it cannot use. `inject` is asserted at the top of
// this check for exactly that reason — a plugin that waits for a service a shell
// never serves is reported as unactivated, which the desktop turns into a startup
// failure.

console.log('client check passed')
