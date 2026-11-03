/**
 * Composition smoke through the real Loader.
 *
 * The verify scripts assemble a `Context` by hand, which tests behaviour but not
 * the composition: a row the Loader cannot resolve, an activation order that
 * starves an injection, or a plugin that never reaches the tool registry would all
 * pass there. This loads a `cordis.yml` the way a deployment does — with a
 * throwaway `DSH_HOME` — and asserts what a model ends up with, then unloads the
 * row's own fiber and asserts the tools go with it.
 *
 *   npm run verify:loader
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const asUrl = relative => pathToFileURL(resolve(root, relative)).href

/** The repository the composition's root points at. */
const home = await mkdtemp(join(tmpdir(), 'dsh-git-loader-'))
const repository = join(home, 'checkout')
await mkdir(repository, { recursive: true })
const raw = (args, cwd) => {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}
raw(['init', '-q', '--initial-branch=main'], repository)
await writeFile(join(repository, 'a.txt'), 'one\n')
raw(['add', '--all'], repository)
raw(['commit', '-q', '-m', 'first'], repository)
await writeFile(join(repository, 'a.txt'), 'two\n')

process.env.DSH_HOME = home
const configPath = join(home, 'cordis.yml')
await writeFile(configPath, [
  "- name: '@deepseek-ai/dsh-system-prompt'",
  '- name: \'@deepseek-ai/dsh-tools\'',
  '  config:',
  '    mode: native',
  '    maxParallelSubCalls: 1',
  `- name: '${asUrl('src/index.ts')}'`,
  '  config:',
  `    root: '${repository.replaceAll('\\', '/')}'`,
  '    maxDepth: 2',
  '',
].join('\n'))

const modules = new Map([
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
])

const ctx = new Context()
ctx.baseUrl = `${pathToFileURL(home).href}/`
await ctx.plugin(Loader)
ctx.loader.builtins.include = Include
// The Loader's own resolution seam: harness packages are reached by name, and
// this repository's row by its file URL, which is how a patch overlay mounts a
// checkout.
ctx.loader.internal = {
  version: 'v2',
  async import(specifier) {
    const known = modules.get(specifier)
    if (known !== undefined) return known
    return await import(specifier)
  },
}
await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
await ctx.loader.await()

for (let attempt = 0; attempt < 300 && ctx.tools.get('git_status') === undefined; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}

assert.ok(ctx.tools.get('git_status'), 'git_status is registered through the Loader')
assert.ok(ctx.tools.get('git_diff'), 'git_diff is registered through the Loader')
assert.ok(ctx.tools.get('git_commit'), 'git_commit is registered through the Loader')

// The composition's root is what a discovery call with no argument scans, and
// the configured checkout is what a status call with no argument reaches (the
// composition sets the root, and a call with no session directory falls back to
// it only through the root list — so the call names the repository explicitly
// here, exactly as a model would after reading git_repos).
const listed = await ctx.tools.get('git_repos').execute({}, { signal: new AbortController().signal })
assert.equal(listed.root, repository, 'the configured root is the one discovery scans')
assert.equal(listed.repos.length, 1, 'the checkout is found')
assert.equal(listed.repos[0].name, 'checkout')
assert.equal(listed.repos[0].unstaged, 1, 'its working-tree edit is counted')
console.log(`composition: ${String(listed.repos.length)} repository under the configured root`)

// The panel's roots route answers the same root the tools used.
const routes = new Map()
ctx.provide('connection', {
  fetch: {
    register: (route) => {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  },
})
for (let attempt = 0; attempt < 200 && routes.size < 4; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}
const rootsRoute = routes.get('/api/dsh-git/roots')
assert.ok(rootsRoute, 'the panel routes are registered through the Loader too')
const rootsAnswer = await (await rootsRoute.fetch(new Request('http://127.0.0.1/api/dsh-git/roots'))).json()
assert.equal(rootsAnswer.default, repository)
console.log('composition: the panel route reports the same root')

// Unloading the row takes its tools with it while the registry stays up. The
// row's own fiber is the one disposed, which is the HMR path a config edit takes.
const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === asUrl('src/index.ts'))
assert.ok(entry, 'the Loader mounted the plugin row')
assert.ok(entry.fiber, 'the plugin row runs a fiber')
await entry.fiber.dispose()
for (let attempt = 0; attempt < 200 && ctx.tools.get('git_status') !== undefined; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 10))
}
assert.ok(ctx.tools, 'the tool registry outlives the plugin row')
assert.equal(ctx.tools.get('git_status'), undefined, 'git_status goes with the row fiber')
assert.equal(ctx.tools.get('git_diff'), undefined, 'git_diff goes with the row fiber')
console.log('unload: the row fiber took its tools, and the registry stayed up')

await rm(home, { recursive: true, force: true })
console.log('loader smoke passed')
process.exit(0)
