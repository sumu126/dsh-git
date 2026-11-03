/**
 * Desktop-runtime gate: run the BUILT plugin on the application's own runtime.
 *
 * The dev checkout beside this plugin is 0.1.6, and "works on 0.1.6" is not the
 * same claim as "works in the app the user is running". This loads the built
 * plugin with the real 0.2.1 `@deepseek-ai/dsh-tools`, the real 0.2.1
 * Schemastery, the real Cordis, and the real tool registry — all imported
 * straight out of `app.asar` — then calls every registered tool against a
 * throwaway repository and validates each answer against the output schema the
 * tool declared.
 *
 * It must run under the desktop application's own Node, because only that Node
 * can import a module from inside the archive:
 *
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & '<app>\DeepSeek Harness.exe' --expose-internals scripts/verify-desktop.mjs
 *
 * or, equivalently, through the launcher the app ships:
 *
 *   $env:DSH_DESKTOP_NODE_EXECUTABLE = '<app>\DeepSeek Harness.exe'
 *   & '<app>\resources\runtime\bin\node.cmd' scripts/verify-desktop.mjs
 *
 * `DSH_DESKTOP_APP` overrides where the application is looked for.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))

/** Where the desktop application lives: its executable's own directory by default. */
const APP = process.env.DSH_DESKTOP_APP ?? dirname(process.execPath)
const ASAR = join(APP, 'resources', 'app.asar')
const HARNESS = `${ASAR}/dsh/node_modules`

if (!existsSync(ASAR)) {
  console.error('verify-desktop needs the desktop application\'s runtime.')
  console.error(`looked for: ${ASAR}`)
  console.error('run it with the app\'s own Node:')
  console.error('  $env:ELECTRON_RUN_AS_NODE = \'1\'')
  console.error('  & \'<app>\\DeepSeek Harness.exe\' --expose-internals scripts/verify-desktop.mjs')
  process.exit(1)
}

/** The entry URL one harness package's root export names. */
function entryOf(name) {
  const base = `${HARNESS}/${name}`
  const manifest = JSON.parse(readFileSync(`${base}/package.json`, 'utf8'))
  const dot = manifest.exports?.['.']
  const target = typeof dot === 'string'
    ? dot
    : typeof dot?.default === 'string' ? dot.default : typeof dot?.import === 'string' ? dot.import : manifest.main ?? 'lib/index.js'
  return `file:///${base}/${target.replace(/^\.\//u, '')}`
}

/** Bare `@deepseek-ai/*` specifiers resolve inside the application archive. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context)
    // A root import only: this probe's subject imports package roots, and the
    // harness packages themselves are resolved from their own manifests.
    const parts = specifier.split('/')
    const name = `${parts[0]}/${parts[1]}`
    const rest = parts.slice(2)
    if (rest.length === 0) {
      try {
        return { url: entryOf(name), shortCircuit: true }
      } catch {
        return nextResolve(specifier, context)
      }
    }
    // A typed subpath (`.ts`) names a file the deployment does not ship; its
    // built counterpart is `lib/types/<name>.js`.
    const file = rest.join('/').replace(/\.ts$/u, '.js').replace(/^src\//u, '')
    for (const candidate of [
      `${HARNESS}/${name}/lib/types/${file}`,
      `${HARNESS}/${name}/lib/${file}`,
      `${HARNESS}/${name}/${file}`,
    ]) {
      try {
        readFileSync(candidate)
        return { url: `file:///${candidate}`, shortCircuit: true }
      } catch {
        // Try the next spelling.
      }
    }
    return nextResolve(specifier, context)
  },
})

console.log(`desktop node ${process.version}`)
const { Context } = await import(entryOf('@deepseek-ai/cordis'))
const SystemPrompt = (await import(entryOf('@deepseek-ai/dsh-system-prompt'))).default
const { ToolRuntime } = await import(entryOf('@deepseek-ai/dsh-tools'))
const { validateJsonSchemaValue } = await import(`file:///${HARNESS}/@deepseek-ai/dsh-tools/lib/types/json-schema.js`)
const plugin = await import(pathToFileURL(resolve(scriptDirectory, '..', 'lib', 'index.js')).href)
const ROUTES = {
  roots: '/api/dsh-git/roots',
  repos: '/api/dsh-git/repos',
  status: '/api/dsh-git/status',
  diff: '/api/dsh-git/diff',
}
console.log('runtime imported: cordis, system-prompt, dsh-tools, schemastery')

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-git-desktop-'))
process.on('exit', () => {
  // A git process may still hold the directory for a moment on Windows; the
  // probe's subject is the plugin, not the cleanup.
  try {
    rmSync(ROOT, { recursive: true, force: true })
  } catch {
    // Left for the platform's own temporary-file cleanup.
  }
})

/** Run git directly, for the fixture. */
function raw(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

const REPO = join(ROOT, 'checkout')
mkdirSync(REPO, { recursive: true })
raw(REPO, ['init', '-q', '--initial-branch=main'])
writeFileSync(join(REPO, 'alpha.txt'), 'one\n')
raw(REPO, ['add', '--all'])
raw(REPO, ['commit', '-q', '-m', 'initial commit'])
writeFileSync(join(REPO, 'alpha.txt'), 'one\ntwo\n')
writeFileSync(join(REPO, 'brand new.txt'), 'new\n')

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime, { mode: 'native', maxParallelSubCalls: 1 })
await ctx.plugin(plugin, { root: ROOT, maxDepth: 3, maxRepos: 10 })
ctx.provide('workingDirectory', { ensure: async () => REPO })

const routes = new Map()
ctx.provide('connection', {
  fetch: {
    register: (route) => {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  },
})

const NAMES = [
  'git_repos', 'git_status', 'git_log', 'git_diff', 'git_show',
  'git_branches', 'git_remotes', 'git_stage', 'git_commit', 'git_switch',
]
for (let attempt = 0; attempt < 200 && ctx.tools?.get('git_status') === undefined; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}
assert.ok(ctx.tools, 'the tool registry is served')
for (const name of NAMES) assert.ok(ctx.tools.get(name), `${name} is registered on 0.2.1`)
console.log(`registered on 0.2.1: ${NAMES.join(', ')}`)

const CALL = { signal: new AbortController().signal, agent: 'probe' }

/** Assert one tool's answer satisfies the schema it declared. */
function assertOutput(name, value) {
  const tool = ctx.tools.get(name)
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
  assert.deepEqual(violations, [], `${name} returns what its output schema declares`)
}

const status = await ctx.tools.get('git_status').execute({}, CALL)
assert.equal(status.repo.name, 'checkout')
assert.equal(status.repo.unstaged, 1)
assert.equal(status.repo.untracked, 1)
assertOutput('git_status', status)
console.log(`git_status: ${status.repo.branch}, ${String(status.repo.unstaged)} unstaged, ${String(status.repo.untracked)} untracked`)

const log = await ctx.tools.get('git_log').execute({ limit: 3 }, CALL)
assert.equal(log.commits.length, 1)
assertOutput('git_log', log)

const diff = await ctx.tools.get('git_diff').execute({ scope: 'working' }, CALL)
assert.match(diff.patch, /\+two/u)
assertOutput('git_diff', diff)

const show = await ctx.tools.get('git_show').execute({ ref: 'HEAD' }, CALL)
assertOutput('git_show', show)

const branches = await ctx.tools.get('git_branches').execute({}, CALL)
assert.equal(branches.current, 'main')
assertOutput('git_branches', branches)

const remotes = await ctx.tools.get('git_remotes').execute({}, CALL)
assert.deepEqual(remotes.remotes, [])
assertOutput('git_remotes', remotes)

const repos = await ctx.tools.get('git_repos').execute({ root: ROOT }, CALL)
assert.equal(repos.repos.length, 1)
assertOutput('git_repos', repos)

const staged = await ctx.tools.get('git_stage').execute({ mode: 'stage', all: true }, CALL)
assert.equal(staged.repo.staged, 2)
assertOutput('git_stage', staged)

const committed = await ctx.tools.get('git_commit').execute({ message: 'from the desktop probe' }, CALL)
assert.equal(committed.commit.subject, 'from the desktop probe')
assertOutput('git_commit', committed)

const switched = await ctx.tools.get('git_switch').execute({ branch: 'probe-branch', create: true }, CALL)
assert.equal(switched.repo.branch, 'probe-branch')
assertOutput('git_switch', switched)
console.log('all ten tools executed and satisfied their output schemas')

// Presentation metadata has to be JSON the session log can store.
const meta = ctx.tools.get('git_status').output.presentationMeta({}, status)
assert.equal(meta.card, 'git')
assert.equal(meta.variant, 'status')
assert.doesNotThrow(() => JSON.stringify(meta))
console.log('metadata: the status card is JSON and carries its discriminator')

// The panel's routes have to register on the 0.2.1 carrier too.
for (let attempt = 0; attempt < 100 && routes.size < 4; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
assert.equal(routes.size, 4, 'four panel routes are registered')
for (const path of Object.values(ROUTES)) {
  assert.ok(routes.has(path), `${path} is registered`)
}
const answer = await routes.get(ROUTES.status).fetch(
  new Request(`http://127.0.0.1${ROUTES.status}?repo=checkout`),
)
const body = await answer.json()
assert.equal(body.status.repo.name, 'checkout')
console.log('routes: the panel reads the same repository the tools read')

await ctx.fiber.dispose()
console.log('desktop check passed')
process.exit(0)
