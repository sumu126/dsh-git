/**
 * Host check: mount the plugin on a real Cordis context with the real tool
 * registry, then call every tool it registered and validate what each answered
 * against the output schema it declared.
 *
 * A tool that returns a value its schema does not describe is a failure only a
 * running deployment would show; this moves it here, where the tool is named.
 * The same run exercises the panel's four routes through a stand-in browser
 * carrier, so a route and a tool can be compared on one repository.
 *
 * Run it from this plugin's directory; `tsconfig.json` points `@deepseek-ai/*`
 * at the harness checkout beside it, and tsx resolves those paths.
 *
 *   npm run verify:host
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools/src/json-schema.ts'
import * as gitPlugin from '../src/index.ts'
import { GIT_DIFF_PATH, GIT_REPOS_PATH, GIT_ROOTS_PATH, GIT_STATUS_PATH } from '../src/contract.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-git-host-'))
process.on('exit', () => { rmSync(ROOT, { recursive: true, force: true }) })

/** Run git directly, for the fixtures a check needs. */
function raw(cwd, args, input) {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', input,
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** Create one initialized repository. */
function makeRepo(name) {
  const directory = join(ROOT, name)
  mkdirSync(directory, { recursive: true })
  raw(directory, ['init', '-q', '--initial-branch=main'])
  return directory
}

/** Write one file. */
function put(directory, file, contents) {
  const target = join(directory, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

/** Stage and commit everything. */
function setupCommit(directory, message) {
  raw(directory, ['add', '--all'])
  raw(directory, ['commit', '-q', '-m', message])
}

const REPO = makeRepo('work')
put(REPO, 'alpha.txt', 'one\n')
setupCommit(REPO, 'initial commit')
put(REPO, 'alpha.txt', 'one\ntwo\n')
put(REPO, 'brand new.txt', 'new\n')

const ALL_TOOLS = [
  'git_repos', 'git_status', 'git_log', 'git_diff', 'git_show',
  'git_branches', 'git_remotes', 'git_stage', 'git_commit', 'git_switch',
]

/** One call's execution context: the cancellation every tool body must observe. */
function call(agent) {
  return { signal: new AbortController().signal, agent }
}

/**
 * Mount the plugin with a real tool registry and a stand-in directory service.
 * @param config - composition values.
 * @param options - the directory the session reports, and the roots a workspace
 * registry would list.
 * @returns the context and the fetch routes the plugin registered.
 */
async function mount(config = {}, options = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 })
  await ctx.plugin(gitPlugin, config)
  const directory = options.directory ?? REPO
  ctx.provide('workingDirectory', {
    ensure: async () => directory,
  })
  if (options.workspaces !== undefined) {
    ctx.provide('workspaceRegistry', {
      list: () => options.workspaces,
    })
  }
  const routes = new Map()
  ctx.provide('connection', {
    fetch: {
      register: (route) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  })
  for (let attempt = 0; attempt < 100 && routes.size < 4; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return { ctx, routes }
}

/** Assert one value satisfies the output schema its tool declared. */
function assertOutput(ctx, name, value) {
  const tool = ctx.tools.get(name)
  assert.ok(tool, `${name} is registered`)
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
  assert.deepEqual(violations, [], `${name} returns what its output schema declares`)
}

/** Assert one call's presentation metadata has the shape the client reads. */
function assertMeta(ctx, name, args, value, variant) {
  const tool = ctx.tools.get(name)
  assert.equal(typeof tool.output.presentationMeta, 'function', `${name} declares presentation metadata`)
  const meta = tool.output.presentationMeta(args, value)
  assert.equal(meta.card, 'git', `${name}'s metadata carries the git card tag`)
  assert.equal(meta.variant, variant, `${name}'s metadata carries variant=${variant}`)
  assert.equal(typeof meta.truncated, 'boolean', `${name}'s metadata says whether it was cut`)
  return meta
}

/** Call one registered route the way the panel does. */
async function callRoute(routes, path, query = {}) {
  const route = routes.get(path)
  assert.ok(route !== undefined, `${path} is registered`)
  const url = new URL(`http://127.0.0.1${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const response = await route.fetch(new Request(url, { method: 'GET' }))
  return { status: response.status, body: await response.json() }
}

// ---- The registered surface ------------------------------------------------

const { ctx, routes } = await mount({
  root: ROOT,
  maxDepth: 4,
  maxRepos: 20,
})
for (const name of ALL_TOOLS) assert.ok(ctx.tools.get(name), `${name} is registered`)
console.log(`registered tools: ${ALL_TOOLS.join(', ')}`)

const toolNames = ctx.tools.schemas().map(schema => schema.name).filter(name => name.startsWith('git_')).sort()
assert.deepEqual(toolNames, [...ALL_TOOLS].sort(), 'the model sees exactly this plugin\'s tools')

// Every description has to say what the tool does without naming a deployment.
for (const name of ALL_TOOLS) {
  const description = ctx.tools.get(name).description
  assert.ok(description.length > 40, `${name}'s description explains itself`)
}

// ---- The reads -------------------------------------------------------------

const status = await ctx.tools.get('git_status').execute({}, call('s'))
assert.equal(status.repo.name, 'work')
assert.equal(status.repo.branch, 'main')
assert.equal(status.repo.unstaged, 1)
assert.equal(status.repo.untracked, 1)
assert.deepEqual(status.files.map(file => file.path).sort(), ['alpha.txt', 'brand new.txt'])
assertOutput(ctx, 'git_status', status)
const statusMeta = assertMeta(ctx, 'git_status', {}, status, 'status')
assert.equal(statusMeta.repo, 'work')
assert.equal(statusMeta.total, 2)
assert.equal(statusMeta.unstaged, 1)
console.log(`git_status: ${status.repo.name} on ${status.repo.branch}, ${String(status.repo.unstaged)} unstaged`)

const log = await ctx.tools.get('git_log').execute({ limit: 5 }, call('s'))
assert.equal(log.commits.length, 1)
assert.equal(log.commits[0].subject, 'initial commit')
assert.deepEqual(log.commits[0].parents, [])
assertOutput(ctx, 'git_log', log)
assertMeta(ctx, 'git_log', { limit: 5 }, log, 'log')

const diff = await ctx.tools.get('git_diff').execute({ scope: 'working' }, call('s'))
assert.equal(diff.files.length, 1)
assert.equal(diff.files[0].path, 'alpha.txt')
assert.match(diff.patch, /\+two/u)
assertOutput(ctx, 'git_diff', diff)
const diffMeta = assertMeta(ctx, 'git_diff', { scope: 'working' }, diff, 'diff')
assert.equal(diffMeta.scope, 'working')
assert.equal(diffMeta.additions, 1)

const show = await ctx.tools.get('git_show').execute({ ref: 'HEAD' }, call('s'))
assert.equal(show.commit.subject, 'initial commit')
assert.equal(show.files[0].path, 'alpha.txt')
assert.match(show.patch, /\+one/u)
assertOutput(ctx, 'git_show', show)
assertMeta(ctx, 'git_show', { ref: 'HEAD' }, show, 'commit')

const showNoPatch = await ctx.tools.get('git_show').execute({ ref: 'HEAD', patch: false }, call('s'))
assert.equal(showNoPatch.patch, undefined)
assertOutput(ctx, 'git_show', showNoPatch)

const branches = await ctx.tools.get('git_branches').execute({}, call('s'))
assert.deepEqual(branches.branches.map(branch => branch.name), ['main'])
assert.equal(branches.current, 'main')
assertOutput(ctx, 'git_branches', branches)
assertMeta(ctx, 'git_branches', {}, branches, 'branches')

const remotes = await ctx.tools.get('git_remotes').execute({}, call('s'))
assert.deepEqual(remotes.remotes, [])
assertOutput(ctx, 'git_remotes', remotes)
assertMeta(ctx, 'git_remotes', {}, remotes, 'remotes')

const repos = await ctx.tools.get('git_repos').execute({ root: ROOT }, call('s'))
assert.equal(repos.root, ROOT)
assert.equal(repos.repos.length, 1)
assert.equal(repos.repos[0].name, 'work')
assertOutput(ctx, 'git_repos', repos)
assertMeta(ctx, 'git_repos', { root: ROOT }, repos, 'repos')
console.log(`git_repos: ${String(repos.repos.length)} repository under the root`)

// The tools address a repository by name, not only by path: the model reads a
// name from git_repos and may well use it next.
const byName = await ctx.tools.get('git_status').execute({ repo: 'work' }, call('s'))
assert.equal(byName.repo.path, REPO)
assertOutput(ctx, 'git_status', byName)
console.log('git_status: a repository is addressable by its name')

// ---- The mutations ---------------------------------------------------------

const staged = await ctx.tools.get('git_stage').execute({ mode: 'stage', paths: ['alpha.txt'] }, call('s'))
assert.equal(staged.repo.staged, 1)
assertOutput(ctx, 'git_stage', staged)
assertMeta(ctx, 'git_stage', { mode: 'stage' }, staged, 'action')

const committed = await ctx.tools.get('git_commit').execute({ message: 'second commit' }, call('s'))
assert.equal(committed.commit.subject, 'second commit')
assert.deepEqual(committed.files.map(file => file.path), ['alpha.txt'])
assertOutput(ctx, 'git_commit', committed)
assertMeta(ctx, 'git_commit', { message: 'second commit' }, committed, 'commit')

const switched = await ctx.tools.get('git_switch').execute({ branch: 'topic', create: true }, call('s'))
assert.equal(switched.repo.branch, 'topic')
assertOutput(ctx, 'git_switch', switched)
assertMeta(ctx, 'git_switch', { branch: 'topic' }, switched, 'action')
const back = await ctx.tools.get('git_switch').execute({ branch: 'main' }, call('s'))
assert.equal(back.repo.branch, 'main')
console.log('git_stage / git_commit / git_switch: a staged edit became a commit and a branch was created')

// ---- Refusals are errors, not empty answers --------------------------------

const notARepo = join(ROOT, 'plain')
mkdirSync(notARepo, { recursive: true })
const refusedStatus = await ctx.tools.get('git_status').execute({ repo: notARepo }, call('s'))
  .then(() => undefined, error => error)
assert.ok(refusedStatus instanceof Error, 'a directory outside a repository fails the call')
assert.match(refusedStatus.message, /not inside a git repository/u)
console.log(`refusal: ${refusedStatus.message}`)

const emptyMessage = await ctx.tools.get('git_commit').execute({ message: '   ' }, call('s'))
  .then(() => undefined, error => error)
assert.match(emptyMessage.message, /a commit needs a message/u)

const badScope = await ctx.tools.get('git_diff').execute({ scope: 'nonsense' }, call('s'))
  .then(() => undefined, error => error)
assert.match(badScope.message, /unknown diff scope/u)

const discardAll = await ctx.tools.get('git_stage').execute({ mode: 'discard', all: true }, call('s'))
  .then(() => undefined, error => error)
assert.match(discardAll.message, /discarding every change at once/u)
console.log('refusals: a non-repository, an empty message, an unknown scope, and a blanket discard all fail the call')

// ---- The panel's routes ----------------------------------------------------

const roots = await callRoute(routes, GIT_ROOTS_PATH)
assert.equal(roots.status, 200)
assert.equal(roots.body.default, ROOT, 'the configured root is the default')
assert.deepEqual(roots.body.roots.map(entry => entry.source), ['config', 'session'], 'the configured root, then the session directory')
console.log(`route ${GIT_ROOTS_PATH}: ${roots.body.roots.map(entry => entry.path).join(', ')}`)

const listed = await callRoute(routes, GIT_REPOS_PATH, { root: ROOT })
assert.equal(listed.status, 200)
assert.equal(listed.body.root, ROOT)
assert.equal(listed.body.repos[0].name, 'work')
assert.equal(listed.body.truncated, false)

const routeStatus = await callRoute(routes, GIT_STATUS_PATH, { repo: 'work' })
assert.equal(routeStatus.status, 200)
assert.equal(routeStatus.body.status.repo.name, 'work')
assert.equal(routeStatus.body.status.repo.branch, 'main')

const routeDiff = await callRoute(routes, GIT_DIFF_PATH, { repo: 'work', scope: 'staged' })
assert.equal(routeDiff.status, 200)
assert.equal(routeDiff.body.diff.scope, 'staged')

// A route answers a refusal as a body: the panel renders the sentence instead of
// reporting a transport failure.
const routeRefusal = await callRoute(routes, GIT_STATUS_PATH, { repo: 'nope' })
assert.equal(routeRefusal.status, 200)
assert.match(routeRefusal.body.message, /neither a directory nor the name of a repository/u)
const routeNotARepo = await callRoute(routes, GIT_STATUS_PATH, { repo: notARepo })
assert.equal(routeNotARepo.status, 200)
assert.match(routeNotARepo.body.message, /not inside a git repository/u)
console.log('routes: repos, status, and diff answer the panel; a refusal is a message in a 200')
await ctx.fiber.dispose()

// ---- A deployment that allows only reads -----------------------------------

const readOnly = await mount({ root: ROOT, allowStage: false, allowCommit: false, allowSwitch: false })
for (const name of ['git_stage', 'git_commit', 'git_switch']) {
  assert.equal(readOnly.ctx.tools.get(name), undefined, `${name} is not offered when its switch is off`)
}
for (const name of ['git_status', 'git_log', 'git_diff', 'git_show', 'git_branches', 'git_remotes', 'git_repos']) {
  assert.ok(readOnly.ctx.tools.get(name), `${name} is still offered`)
}
console.log('read-only deployment: the three mutating tools are absent from the surface')
await readOnly.ctx.fiber.dispose()

// ---- Roots a deployment did not configure ----------------------------------

const workspace = makeRepo('registered/checkout')
const discovery = await mount({}, { directory: workspace, workspaces: [{ path: workspace, title: 'Registered' }] })
const discoveredRoots = await callRoute(discovery.routes, GIT_ROOTS_PATH)
assert.deepEqual(
  discoveredRoots.body.roots.map(entry => [entry.title, entry.source]),
  [['Registered', 'workspace']],
  'a deployment with no configured root offers the registered workspace',
)
const discoveredRepos = await callRoute(discovery.routes, GIT_REPOS_PATH)
assert.equal(discoveredRepos.body.root, workspace, 'the first root is what a request with none scans')
assert.equal(discoveredRepos.body.repos[0].name, 'checkout')
console.log('roots: a deployment with no configured root offers its registered workspace')
await discovery.ctx.fiber.dispose()

console.log('host check passed')
