/**
 * Live checks: the reads and the mutations this plugin performs, against real
 * repositories created in a temporary directory.
 *
 * The parsers are pinned by fixtures; this suite pins the *commands* — that a
 * status read really uses porcelain v2, that a diff really applies the byte
 * bound, that staging really stages, that a message beginning with a dash really
 * reaches git as a message rather than as an option, and that a repository with
 * no commits, a bare repository, and a diverged upstream all answer instead of
 * throwing.
 *
 *   npm run test:live
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import {
  Git, applyStage, createCommit, directoryExists, discoverRepos, identifyRepo, listRepos,
  readBranches, readCommit, readDiff, readLog, readRemotes, readStatus, summarizeRepo, switchBranch,
} from '../src/git.ts'

/** The temporary tree every repository in this suite lives under. */
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-git-live-'))
after(() => { rmSync(ROOT, { recursive: true, force: true }) })

/** The bounded runner under test. */
const git = new Git({ command: 'git', timeoutMs: 30_000, maxOutputBytes: 1_048_576 })

/**
 * Run git directly, for the setup a check needs before it can read anything.
 * @param cwd - where to run.
 * @param args - the command.
 * @param input - standard input.
 * @returns standard output.
 */
function raw(cwd: string, args: string[], input?: string): string {
  const result = spawnSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args,
  ], { cwd, encoding: 'utf8', input })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** Create one initialized repository under the temporary root. */
function makeRepo(name: string): string {
  const directory = join(ROOT, name)
  mkdirSync(directory, { recursive: true })
  raw(directory, ['init', '-q', '--initial-branch=main'])
  return directory
}

/** Write one file, creating its directory. */
function put(directory: string, file: string, contents: string): void {
  const target = join(directory, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents)
}

/** Commit everything currently staged, as a check's setup does it. */
function setupCommit(directory: string, message: string): void {
  raw(directory, ['add', '--all'])
  raw(directory, ['commit', '-q', '-m', message])
}

test('a fresh repository is clean, unborn, and says so', async () => {
  const directory = makeRepo('fresh')
  const repo = await identifyRepo(git, directory)
  assert.equal(repo.worktree, directory)
  assert.equal(repo.bare, false)
  assert.equal(repo.name, 'fresh')
  const status = await readStatus(git, repo)
  assert.equal(status.repo.branch, 'main')
  assert.equal(status.repo.head, null, 'a repository with no commit has no head')
  assert.equal(status.repo.dirty, false)
  assert.deepEqual(status.files, [])
  assert.equal(status.filesTruncated, false)
})

test('a working edit, a staged edit, and an untracked file are counted apart', async () => {
  const directory = makeRepo('counts')
  put(directory, 'tracked.txt', 'one\n')
  setupCommit(directory, 'base')
  put(directory, 'tracked.txt', 'one\ntwo\n')
  put(directory, 'staged.txt', 'staged\n')
  put(directory, 'untracked file.txt', 'new\n')
  raw(directory, ['add', 'staged.txt'])
  const repo = await identifyRepo(git, directory)
  const status = await readStatus(git, repo)
  assert.equal(status.repo.staged, 1)
  assert.equal(status.repo.unstaged, 1)
  assert.equal(status.repo.untracked, 1)
  assert.equal(status.repo.conflicted, 0)
  assert.equal(status.repo.dirty, true)
  assert.deepEqual(status.files.map(file => file.path).sort(), ['staged.txt', 'tracked.txt', 'untracked file.txt'])
})

test('staging answers the status it left behind, and unstaging takes it back', async () => {
  const directory = makeRepo('stage')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  put(directory, 'a.txt', 'two\n')
  put(directory, 'b.txt', 'new\n')
  const repo = await identifyRepo(git, directory)
  const staged = await applyStage(git, repo, { mode: 'stage', paths: ['a.txt', 'b.txt'] })
  assert.equal(staged.repo.staged, 2)
  assert.equal(staged.repo.unstaged, 0)
  const unstaged = await applyStage(git, repo, { mode: 'unstage', paths: ['a.txt'] })
  assert.equal(unstaged.repo.staged, 1, 'only the remaining path is still staged')
  assert.equal(unstaged.repo.unstaged, 1)
})

test('staging everything includes an untracked file, and no paths at all is refused', async () => {
  const directory = makeRepo('stage-all')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  put(directory, 'new.txt', 'new\n')
  const repo = await identifyRepo(git, directory)
  const staged = await applyStage(git, repo, { mode: 'stage', all: true })
  assert.equal(staged.repo.staged, 1)
  assert.equal(staged.repo.untracked, 0)
  await assert.rejects(
    async () => await applyStage(git, repo, { mode: 'stage' }),
    /name at least one path, or pass all: true/u,
  )
})

test('discarding every change at once is refused, and naming a path works', async () => {
  const directory = makeRepo('discard')
  put(directory, 'a.txt', 'one\n')
  put(directory, 'b.txt', 'one\n')
  setupCommit(directory, 'base')
  put(directory, 'a.txt', 'two\n')
  put(directory, 'b.txt', 'two\n')
  const repo = await identifyRepo(git, directory)
  await assert.rejects(
    async () => await applyStage(git, repo, { mode: 'discard', all: true }),
    /discarding every change at once is not supported/u,
  )
  const status = await applyStage(git, repo, { mode: 'discard', paths: ['a.txt'] })
  assert.deepEqual(status.files.map(file => file.path), ['b.txt'], 'the named path was reverted, the other was not')
})

test('a commit is made from the staged tree, and a message beginning with a dash stays a message', async () => {
  const directory = makeRepo('commit')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  put(directory, 'a.txt', 'two\n')
  put(directory, 'b.txt', 'new\n')
  const repo = await identifyRepo(git, directory)
  await applyStage(git, repo, { mode: 'stage', all: true })
  const committed = await createCommit(git, repo, { message: '-not an option\n\nA body line.' })
  assert.equal(committed.commit.subject, '-not an option', 'the whole message reached git as a message')
  assert.deepEqual(committed.files.map(file => file.path).sort(), ['a.txt', 'b.txt'])
  assert.equal((await readStatus(git, repo)).repo.dirty, false)
  const log = await readLog(git, repo, { limit: 1 })
  assert.equal(log[0]?.hash, committed.commit.hash)
  assert.deepEqual(log[0]?.parents, [committed.commit.parents[0]], 'a normal commit has one parent')
})

test('a commit needs a message, and a commit with nothing staged is refused by git', async () => {
  const directory = makeRepo('commit-guard')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  const repo = await identifyRepo(git, directory)
  await assert.rejects(async () => await createCommit(git, repo, { message: '   ' }), /a commit needs a message/u)
  await assert.rejects(async () => await createCommit(git, repo, { message: 'nothing here' }), /nothing to commit|no changes added/u)
})

test('working, staged, commit, and range diffs each describe their own comparison', async () => {
  const directory = makeRepo('diff')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  put(directory, 'a.txt', 'one\ntwo\n')
  const repo = await identifyRepo(git, directory)

  const working = await readDiff(git, repo, { scope: 'working', maxBytes: 65_536 })
  assert.deepEqual(working.files, [{ status: 'M', path: 'a.txt' }])
  assert.equal(working.additions, 1)
  assert.equal(working.deletions, 0)
  assert.match(working.patch, /\+two/u)

  const stagedEmpty = await readDiff(git, repo, { scope: 'staged', maxBytes: 65_536 })
  assert.deepEqual(stagedEmpty.files, [], 'nothing is staged yet')
  assert.equal(stagedEmpty.patch, '')

  await applyStage(git, repo, { mode: 'stage', paths: ['a.txt'] })
  const staged = await readDiff(git, repo, { scope: 'staged', maxBytes: 65_536 })
  assert.deepEqual(staged.files, [{ status: 'M', path: 'a.txt' }])
  assert.equal(staged.additions, 1)

  await createCommit(git, repo, { message: 'second' })
  put(directory, 'a.txt', 'one\ntwo\nthree\n')
  await applyStage(git, repo, { mode: 'stage', paths: ['a.txt'] })
  await createCommit(git, repo, { message: 'third' })

  const commit = await readDiff(git, repo, { scope: 'commit', ref: 'HEAD', maxBytes: 65_536 })
  assert.equal(commit.ref, 'HEAD')
  assert.deepEqual(commit.files, [{ status: 'M', path: 'a.txt' }])
  assert.match(commit.patch, /\+three/u)

  const range = await readDiff(git, repo, { scope: 'range', ref: 'HEAD~2..HEAD', maxBytes: 65_536 })
  assert.equal(range.additions, 2, 'the range covers both commits')
  const paths = await readDiff(git, repo, { scope: 'range', ref: 'HEAD~2..HEAD', paths: ['a.txt'], maxBytes: 65_536 })
  assert.equal(paths.files.length, 1)
})

test('a diff past its byte bound is cut and says so, and the totals still cover all of it', async () => {
  const directory = makeRepo('diff-cut')
  put(directory, 'big.txt', 'start\n')
  setupCommit(directory, 'base')
  put(directory, 'big.txt', Array.from({ length: 400 }, (_, line) => `line ${String(line)}\n`).join(''))
  const repo = await identifyRepo(git, directory)
  const cut = await readDiff(git, repo, { scope: 'working', maxBytes: 512 })
  assert.equal(cut.truncated, true)
  assert.ok(cut.patch.length < 2_000, 'the patch text really was cut')
  assert.match(cut.patch, /patch cut at 512 bytes/u)
  assert.equal(cut.additions, 400, 'the totals are not cut')
})

test('a range diff needs a range', async () => {
  const directory = makeRepo('range-guard')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  const repo = await identifyRepo(git, directory)
  await assert.rejects(
    async () => await readDiff(git, repo, { scope: 'range', ref: 'HEAD', maxBytes: 1024 }),
    /needs a revision range/u,
  )
})

test('log reads a bound, a path, an author, and a range', async () => {
  const directory = makeRepo('log')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'first')
  put(directory, 'b.txt', 'one\n')
  setupCommit(directory, 'second')
  put(directory, 'a.txt', 'two\n')
  setupCommit(directory, 'third')
  const repo = await identifyRepo(git, directory)

  assert.deepEqual((await readLog(git, repo, { limit: 2 })).map(commit => commit.subject), ['third', 'second'])
  assert.deepEqual((await readLog(git, repo, { limit: 10, path: 'b.txt' })).map(commit => commit.subject), ['second'])
  assert.deepEqual((await readLog(git, repo, { limit: 10, author: 'nobody' })), [])
  assert.deepEqual((await readLog(git, repo, { limit: 10, ref: 'HEAD~1' })).map(commit => commit.subject), ['second', 'first'])
  assert.deepEqual((await readLog(git, repo, { limit: 10, all: true })).length, 3)
})

test('a revision beginning with a dash is refused before git sees it', async () => {
  const directory = makeRepo('revision-guard')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  const repo = await identifyRepo(git, directory)
  await assert.rejects(
    async () => await readLog(git, repo, { limit: 1, ref: '--output=/tmp/x' }),
    /must not begin with "-"/u,
  )
  await assert.rejects(
    async () => await readDiff(git, repo, { scope: 'commit', ref: '--output=/tmp/x', maxBytes: 1024 }),
    /must not begin with "-"/u,
  )
})

test('branches read ahead and behind against a real upstream', async () => {
  const origin = join(ROOT, 'origin-branches.git')
  raw(ROOT, ['init', '-q', '--bare', '--initial-branch=main', origin])
  const directory = makeRepo('branches')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  raw(directory, ['remote', 'add', 'origin', origin])
  raw(directory, ['push', '-q', '-u', 'origin', 'main'])

  const repo = await identifyRepo(git, directory)
  const remotes = await readRemotes(git, repo)
  assert.deepEqual(remotes.map(remote => remote.name), ['origin'])
  assert.equal(remotes[0]?.push, origin)
  assert.equal(remotes[0]?.fetch, origin)

  const upToDate = await readBranches(git, repo, { includeRemote: true })
  const local = upToDate.find(branch => branch.name === 'main')
  assert.equal(local?.current, true)
  assert.equal(local?.track, 'tracked')
  assert.equal(local?.ahead, 0)
  assert.equal(local?.behind, 0)
  assert.ok(upToDate.some(branch => branch.name === 'origin/main' && branch.local === false))

  // Diverge: one commit here, one commit on the remote's side.
  put(directory, 'a.txt', 'local\n')
  setupCommit(directory, 'local ahead')
  const other = join(ROOT, 'branches-other')
  raw(ROOT, ['clone', '-q', origin, other])
  raw(other, ['-c', 'user.name=Other', '-c', 'user.email=other@example.com', 'commit', '-q', '--allow-empty', '-m', 'remote commit'])
  raw(other, ['push', '-q'])
  raw(directory, ['fetch', '-q', 'origin'])

  const diverged = await readBranches(git, repo, { includeRemote: true })
  const main = diverged.find(branch => branch.name === 'main')
  assert.equal(main?.ahead, 1)
  assert.equal(main?.behind, 1)
  const status = await readStatus(git, repo)
  assert.equal(status.repo.ahead, 1)
  assert.equal(status.repo.behind, 1)
  assert.equal(status.repo.upstream, 'origin/main')
})

test('a branch is created, switched to, and a missing one is refused', async () => {
  const directory = makeRepo('switch')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  const repo = await identifyRepo(git, directory)
  const created = await switchBranch(git, repo, { branch: 'feat/x', create: true })
  assert.equal(created.repo.branch, 'feat/x')
  const back = await switchBranch(git, repo, { branch: 'main' })
  assert.equal(back.repo.branch, 'main')
  await assert.rejects(
    async () => await switchBranch(git, repo, { branch: 'nope' }),
    /invalid reference|not a commit|did not match/u,
  )
})

test('a repository is found from any directory inside it', async () => {
  const directory = makeRepo('nested-lookup')
  put(directory, 'src/deep/file.txt', 'x\n')
  setupCommit(directory, 'base')
  const fromInside = await identifyRepo(git, join(directory, 'src', 'deep'))
  assert.equal(fromInside.worktree, directory)
  assert.equal(fromInside.name, 'nested-lookup')
  assert.equal(await directoryExists(join(directory, 'src')), true)
  assert.equal(await directoryExists(join(directory, 'missing')), false)
})

test('discovery finds nested repositories and does not enter dependency or build trees', async () => {
  const root = join(ROOT, 'scan')
  const first = makeRepo('scan/first')
  const second = makeRepo('scan/deep/er/second')
  const ignored = join(root, 'node_modules', 'pretend-repo')
  mkdirSync(ignored, { recursive: true })
  raw(ignored, ['init', '-q'])
  mkdirSync(join(root, 'dist', 'other'), { recursive: true })

  const scan = await discoverRepos(root, { maxDepth: 6, maxRepos: 50 })
  assert.deepEqual(scan.paths.sort(), [first, second].sort())
  assert.equal(scan.truncated, false)

  const bounded = await discoverRepos(root, { maxDepth: 6, maxRepos: 1 })
  assert.equal(bounded.paths.length, 1)
  assert.equal(bounded.truncated, true)

  const shallow = await discoverRepos(root, { maxDepth: 1, maxRepos: 50 })
  assert.deepEqual(shallow.paths, [first], 'the depth bound keeps the deep one out')
})

test('the list read summarizes every repository under a root', async () => {
  const root = join(ROOT, 'list')
  const one = makeRepo('list/one')
  put(one, 'a.txt', 'one\n')
  setupCommit(one, 'base')
  put(one, 'a.txt', 'two\n')
  const two = makeRepo('list/two')
  const listed = await listRepos(git, root, { maxDepth: 4, maxRepos: 20 })
  assert.equal(listed.root, root)
  assert.deepEqual(listed.repos.map(repo => repo.name).sort(), ['one', 'two'])
  assert.equal(listed.repos.find(repo => repo.name === 'one')?.unstaged, 1)
  assert.equal(listed.repos.find(repo => repo.name === 'two')?.dirty, false)
  assert.deepEqual(listed.failures, [])
})

test('a bare repository is addressable by its git directory and has no working tree', async () => {
  const bare = join(ROOT, 'bare.git')
  raw(ROOT, ['init', '-q', '--bare', '--initial-branch=main', bare])
  const repo = await identifyRepo(git, bare)
  assert.equal(repo.bare, true)
  assert.equal(repo.worktree, bare)
  assert.equal(repo.name, 'bare')
  const summary = await summarizeRepo(git, bare)
  assert.equal(summary.branch, 'main')
  assert.equal(summary.head, null)
  await assert.rejects(async () => await readStatus(git, repo), /bare repository/u)
  await assert.rejects(
    async () => await readDiff(git, repo, { scope: 'working', maxBytes: 1024 }),
    /bare repository/u,
  )
})

test('a directory that is not a repository is refused with what it is', async () => {
  const plain = join(ROOT, 'plain')
  mkdirSync(plain, { recursive: true })
  await assert.rejects(async () => await identifyRepo(git, plain), /is not inside a git repository/u)
  await assert.rejects(async () => await identifyRepo(git, join(ROOT, 'nowhere')), /is not a directory/u)
})

test('a read honours the cancellation it was given', async () => {
  const directory = makeRepo('cancel')
  put(directory, 'a.txt', 'one\n')
  setupCommit(directory, 'base')
  const repo = await identifyRepo(git, directory)
  const controller = new AbortController()
  controller.abort()
  // A cancelled call is refused with the reason, rather than left to look like a
  // command that failed for some unexplained reason.
  await assert.rejects(
    async () => await readStatus(git, repo, { signal: controller.signal }),
    /cancelled/u,
  )
})
