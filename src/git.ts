/**
 * The host side of git: one bounded runner, repository resolution, discovery,
 * and the reads the tools and the panel share.
 *
 * Every command is an argv array — never a shell string — with an explicit
 * working directory, a timeout, and a byte cap, so a huge diff or a hook that
 * never returns cannot hold the harness process. Nothing here writes to the
 * index or the working tree on its own: the mutating operations are the tool
 * handlers' own, and each one is named as such.
 *
 * @module dsh-git/src/git
 */

import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type {
  BranchSummary, CommitSummary, DiffFile, DiffPayload, DiffScope, GitLimits, RemoteSummary,
  RepoIdentity, RepoStatus, RepoSummary, StatusFile,
} from './contract.ts'
import {
  countStatus, parseBranches, parseLog, parseNameStatusZ, parseRemotes,
  parseShortStat, parseStatusV2, stripEol,
} from './parse.ts'

/** How one command is invoked. */
export interface GitRunOptions {
  /** Cancellation from the tool call or the HTTP request. */
  signal?: AbortSignal
  /** Text written to the command's standard input. */
  input?: string
  /** Bytes of each stream to keep; defaults to the deployment's bound. */
  maxBytes?: number
  /** Exit codes that are results rather than failures. */
  allowExitCodes?: readonly number[]
  /** Extra environment entries, applied after the git selectors are cleared. */
  env?: Record<string, string>
}

/** What one command produced. */
export interface GitOutcome {
  /** The command, as it was invoked, for an error message. */
  command: string
  /** Standard output, cut at the byte bound. */
  stdout: string
  /** Standard error, cut at the byte bound. */
  stderr: string
  /** Exit code, or -1 when the process was killed before it could report one. */
  code: number
  /** True when either stream was cut at the byte bound. */
  truncated: boolean
  /** True when the deadline killed the command. */
  timedOut: boolean
}

/** A git command that failed, carrying what it said. */
export class GitError extends Error {
  /**
   * @param message - what to show the caller.
   * @param outcome - the command that failed.
   */
  constructor(message: string, readonly outcome: GitOutcome) {
    super(message)
    this.name = 'GitError'
  }
}

/**
 * Variables that would otherwise point a command at another repository or
 * another index than the one it was given.
 *
 * They are cleared rather than trusted: the harness may itself be running under
 * a hook or a rebase, and a `GIT_DIR` inherited from there would silently make
 * every call address the wrong checkout.
 */
const GIT_SELECTORS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
] as const

/** Arguments every invocation carries, so output is stable and never paged. */
const BASE_ARGUMENTS = [
  '--no-pager',
  '-c', 'core.pager=cat',
  '-c', 'core.quotePath=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'color.ui=false',
  '-c', 'advice.detachedHead=false',
] as const

/** Directories a scan never descends into: dependency trees, not projects. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', '.pnpm-store', '.venv', 'venv', '__pycache__',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', 'coverage', 'target',
])

/** The commit format both the log and the show reads use. */
const COMMIT_FORMAT = '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%at%x1f%s%x1f%D%x1f%P%x1e'

/** The branch format `parseBranches` reads. */
const BRANCH_FORMAT = '--format=%(refname)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(committerdate:iso-strict)%1f%(subject)%1e'

/**
 * Refuse an argument that would be read as an option.
 *
 * Nothing here filters a path: a path is always passed after `--`, which is the
 * separator git itself provides. A revision has no such separator on every
 * command, so it is checked here instead.
 * @param value - the revision a caller named.
 * @param label - what to call it in a refusal.
 * @returns the revision, when it is admissible.
 * @throws {Error} when it begins with a dash or holds a control character.
 */
export function assertRevision(value: string, label = 'revision'): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error(`the ${label} must not be empty`)
  if (trimmed.startsWith('-')) throw new Error(`the ${label} "${trimmed}" must not begin with "-"`)
  // eslint-disable-next-line no-control-regex -- rejecting control bytes is the point
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) throw new Error(`the ${label} must not contain control characters`)
  return trimmed
}

/** One command's text, with a refusal when it failed. */
async function failure(outcome: GitOutcome): Promise<never> {
  const said = stripEol(outcome.stderr).trim() || stripEol(outcome.stdout).trim()
  const verb = outcome.timedOut ? 'timed out' : `failed (exit ${String(outcome.code)})`
  throw new GitError(said.length === 0 ? `${outcome.command} ${verb}` : said, outcome)
}

/** The git command line, bounded. */
export class Git {
  /**
   * @param limits - the executable and the two bounds every call runs under.
   */
  constructor(readonly limits: GitLimits) {}

  /**
   * Run one git command to completion.
   *
   * The promise always resolves: a non-zero exit is a value here, and the
   * caller decides whether it is a refusal or a failure. The two cases that are
   * not values — a spawn error and a deadline — resolve as well, so a caller
   * reads one shape.
   * @param cwd - the directory the command runs in.
   * @param args - the command and its literal arguments.
   * @param options - bounds, input, environment, and cancellation.
   * @returns what the command produced.
   */
  async run(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitOutcome> {
    const maxBytes = options.maxBytes ?? this.limits.maxOutputBytes
    const command = [this.limits.command, ...BASE_ARGUMENTS, ...args].join(' ')
    // A caller that already gave up is answered without spawning anything: a
    // cancelled read should not leave a process behind for the deadline to reap.
    if (options.signal?.aborted === true) {
      return {
        command, stdout: '', stderr: 'the call was cancelled', code: -1, truncated: false, timedOut: false,
      }
    }
    const env: Record<string, string | undefined> = { ...process.env }
    for (const selector of GIT_SELECTORS) delete env[selector]
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_OPTIONAL_LOCKS: '0',
      // A read must not rewrite the index it is reporting on; the mutating
      // commands pass their own environment when they need the lock.
      ...options.env ?? {},
    })
    const collected = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const sizes = { stdout: 0, stderr: 0 }
    const cut = { stdout: false, stderr: false }

    return await new Promise<GitOutcome>((resolvePromise) => {
      let child
      try {
        child = spawn(this.limits.command, [...BASE_ARGUMENTS, ...args], {
          cwd,
          env: env as NodeJS.ProcessEnv,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error: unknown) {
        resolvePromise({
          command,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          code: -1,
          truncated: false,
          timedOut: false,
        })
        return
      }

      let timedOut = false
      let aborted = false
      let settled = false
      const finish = (code: number, extra?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
        const stdout = Buffer.concat(collected.stdout).toString('utf8')
        const stderr = Buffer.concat(collected.stderr).toString('utf8')
        // A command killed by the caller's cancellation reports that, not a bare
        // negative exit code: the message is what a user reads.
        const note = aborted ? 'the call was cancelled' : extra
        resolvePromise({
          command,
          // A cut buffer may end in the middle of a codepoint; the replacement
          // character is tidier than a broken one at the end of a patch.
          stdout: cut.stdout ? stdout.replace(/\uFFFD+$/u, '') : stdout,
          stderr: cut.stderr ? stderr.replace(/\uFFFD+$/u, '') : stderr,
          code,
          truncated: cut.stdout || cut.stderr,
          timedOut,
          ...note === undefined ? {} : { stderr: `${stderr}\n${note}` },
        })
      }
      const kill = (): void => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone; the close event is what reports the outcome.
        }
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, this.limits.timeoutMs)
      timer.unref?.()
      const abort = (): void => {
        aborted = true
        kill()
      }
      if (options.signal !== undefined) {
        options.signal.addEventListener('abort', abort, { once: true })
      }

      const collect = (name: 'stdout' | 'stderr') => (chunk: Buffer): void => {
        if (sizes[name] >= maxBytes) {
          cut[name] = true
          return
        }
        const room = maxBytes - sizes[name]
        if (chunk.length <= room) {
          collected[name].push(chunk)
          sizes[name] += chunk.length
        } else {
          collected[name].push(chunk.subarray(0, room))
          sizes[name] = maxBytes
          cut[name] = true
        }
      }
      child.stdout.on('data', collect('stdout'))
      child.stderr.on('data', collect('stderr'))
      // A command killed before it read its input would otherwise raise EPIPE on
      // this side, where an unhandled stream error ends the whole process.
      child.stdin.on('error', () => {})
      child.on('error', (error: Error) => {
        finish(-1, error.message)
      })
      child.on('close', (code: number | null) => {
        finish(code ?? -1)
      })
      if (options.input !== undefined) child.stdin.end(options.input)
      else child.stdin.end()
    })
  }

  /**
   * Run one command and require a successful exit.
   * @param cwd - the directory the command runs in.
   * @param args - the command and its literal arguments.
   * @param options - bounds, input, environment, and cancellation.
   * @returns the outcome, with the command's text on stdout.
   * @throws {GitError} when the command failed.
   */
  async ok(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitOutcome> {
    const outcome = await this.run(cwd, args, options)
    const allow = options.allowExitCodes ?? [0]
    if (outcome.code < 0 || !allow.includes(outcome.code)) await failure(outcome)
    if (outcome.timedOut) await failure(outcome)
    return outcome
  }

  /**
   * Run one command and answer its standard output.
   * @param cwd - the directory the command runs in.
   * @param args - the command and its literal arguments.
   * @param options - bounds, input, environment, and cancellation.
   * @returns standard output, with control characters and line endings intact.
   * @throws {GitError} when the command failed.
   */
  async text(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<string> {
    return (await this.ok(cwd, args, options)).stdout
  }
}

/** Whether a path names a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Whether a path names a directory, without throwing.
 * @param path - the path to check.
 * @returns true when it exists and is a directory.
 */
export async function directoryExists(path: string): Promise<boolean> {
  return await isDirectory(path)
}

/**
 * Resolve one directory to the repository that owns it.
 *
 * The path may be a repository root, a subdirectory of one, or — for a bare
 * repository — the git directory itself, which is the only place a bare
 * repository is addressable.
 * @param git - the bounded runner.
 * @param candidate - an absolute directory path.
 * @param signal - cancellation.
 * @returns the repository identity.
 * @throws {Error} when the path is not a directory or not inside a repository.
 */
export async function identifyRepo(git: Git, candidate: string, signal?: AbortSignal): Promise<RepoIdentity> {
  const directory = resolve(candidate)
  if (!await isDirectory(directory)) throw new Error(`"${candidate}" is not a directory`)
  const options = signal === undefined ? {} : { signal }
  const probe = await git.run(directory, ['rev-parse', '--absolute-git-dir', '--is-bare-repository'], options)
  if (probe.code !== 0) {
    throw new Error(`"${candidate}" is not inside a git repository`)
  }
  const [gitDirLine, bareLine] = probe.stdout.split('\n')
  const gitDir = resolve(stripEol(gitDirLine ?? ''))
  const bare = stripEol(bareLine ?? '').trim() === 'true'
  if (bare) {
    return {
      worktree: gitDir,
      gitDir,
      bare: true,
      name: basename(gitDir).replace(/\.git$/u, '') || basename(gitDir),
    }
  }
  const top = await git.text(directory, ['rev-parse', '--show-toplevel'], options)
  const worktree = resolve(stripEol(top))
  return { worktree, gitDir, bare: false, name: basename(worktree) }
}

/**
 * Discover repositories under one root.
 *
 * The walk is breadth-first and bounded twice — by depth and by count — so a
 * workspace holding a checkout of a large monorepo does not turn one panel read
 * into a filesystem crawl. Symbolic links are not followed, and dependency trees
 * are not entered at all.
 * @param root - the absolute directory to scan.
 * @param options - the depth and count bounds, plus cancellation.
 * @returns the repository roots found, and whether the count bound cut the scan.
 */
export async function discoverRepos(
  root: string,
  options: { maxDepth: number, maxRepos: number, signal?: AbortSignal },
): Promise<{ paths: string[], truncated: boolean }> {
  const found: string[] = []
  const queue: { directory: string, depth: number }[] = [{ directory: resolve(root), depth: 0 }]
  let truncated = false
  while (queue.length > 0) {
    if (options.signal?.aborted === true) break
    const next = queue.shift()
    if (next === undefined) break
    let entries
    try {
      entries = await readdir(next.directory, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some(entry => entry.name === '.git')) found.push(next.directory)
    if (found.length >= options.maxRepos) {
      truncated = true
      break
    }
    if (next.depth >= options.maxDepth) continue
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      queue.push({ directory: join(next.directory, entry.name), depth: next.depth + 1 })
    }
  }
  return { paths: found, truncated }
}

/** Run one async job over a list, with a bounded number in flight. */
async function mapLimit<T, R>(items: readonly T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    for (;;) {
      const index = cursor++
      const item = items[index]
      if (item === undefined) return
      results[index] = await job(item)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Read one repository's status, and summarize it for a list.
 * @param git - the bounded runner.
 * @param repo - the repository to read.
 * @param options - the file bound and cancellation.
 * @returns the summary and every changed path, up to the file bound.
 * @throws {Error} for a bare repository, which has no working tree.
 */
export async function readStatus(
  git: Git,
  repo: RepoIdentity,
  options: { maxFiles?: number, signal?: AbortSignal } = {},
): Promise<RepoStatus> {
  if (repo.bare) throw new Error(`"${repo.name}" is a bare repository, so it has no working tree to report`)
  const outcome = await git.ok(repo.worktree, [
    'status', '--porcelain=v2', '--branch', '--untracked-files=all',
  ], options.signal === undefined ? {} : { signal: options.signal })
  const parsed = parseStatusV2(outcome.stdout)
  const counts = countStatus(parsed.files)
  const summary: RepoSummary = {
    path: repo.worktree,
    name: repo.name,
    branch: parsed.branch,
    detached: parsed.detached,
    head: parsed.head,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    ...counts,
    dirty: counts.staged + counts.unstaged + counts.untracked + counts.conflicted > 0,
  }
  const maxFiles = options.maxFiles ?? parsed.files.length
  const files: StatusFile[] = parsed.files.slice(0, maxFiles)
  return { repo: summary, files, filesTruncated: files.length < parsed.files.length }
}

/**
 * Summarize one repository whose identity is already resolved, without listing
 * its files.
 * @param git - the bounded runner.
 * @param repo - the repository to summarize.
 * @param signal - cancellation.
 * @returns the summary a repository list shows.
 */
async function statusSummary(git: Git, repo: RepoIdentity, signal?: AbortSignal): Promise<RepoSummary> {
  if (repo.bare) {
    const options = signal === undefined ? {} : { signal }
    const branchOutcome = await git.run(repo.gitDir, ['symbolic-ref', '--short', '-q', 'HEAD'], options)
    const headOutcome = await git.run(repo.gitDir, ['rev-parse', '--short', 'HEAD'], options)
    return {
      path: repo.worktree,
      name: repo.name,
      branch: branchOutcome.code === 0 ? stripEol(branchOutcome.stdout) : null,
      detached: branchOutcome.code !== 0,
      head: headOutcome.code === 0 ? stripEol(headOutcome.stdout) : null,
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      dirty: false,
    }
  }
  return (await readStatus(git, repo, { maxFiles: 0, ...signal === undefined ? {} : { signal } })).repo
}

/**
 * Summarize one repository without listing its files.
 * @param git - the bounded runner.
 * @param path - the repository root, or any directory inside it.
 * @param signal - cancellation.
 * @returns the summary a repository list shows.
 */
export async function summarizeRepo(git: Git, path: string, signal?: AbortSignal): Promise<RepoSummary> {
  return await statusSummary(git, await identifyRepo(git, path, signal), signal)
}

/**
 * List the repositories under one root with their status.
 * @param git - the bounded runner.
 * @param root - the directory to scan.
 * @param options - scan bounds, status bound, and cancellation.
 * @returns the summaries, the roots that could not be read, and whether the scan was cut.
 */
export async function listRepos(
  git: Git,
  root: string,
  options: { maxDepth: number, maxRepos: number, maxFiles?: number, signal?: AbortSignal },
): Promise<{ root: string, repos: RepoSummary[], failures: string[], truncated: boolean }> {
  const scan = await discoverRepos(root, options)
  const failures: string[] = []
  const summaries = await mapLimit(scan.paths, 4, async (path) => {
    try {
      return await summarizeRepo(git, path, options.signal)
    } catch (error: unknown) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  })
  return {
    root: resolve(root),
    repos: summaries.filter((summary): summary is RepoSummary => summary !== undefined),
    failures,
    truncated: scan.truncated,
  }
}

/** How one log read is bounded. */
export interface LogRequest {
  /** Commits to read. */
  limit: number
  /** Revision or range to walk, defaulting to HEAD. */
  ref?: string
  /** Only commits touching this path. */
  path?: string
  /** Only commits by this author. */
  author?: string
  /** Walk every ref, not only HEAD. */
  all?: boolean
  /** Cancellation. */
  signal?: AbortSignal
}

/**
 * Read one repository's history.
 * @param git - the bounded runner.
 * @param repo - the repository to read.
 * @param request - the bound, the revision, and the filters.
 * @returns the commits git printed, newest first.
 */
export async function readLog(git: Git, repo: RepoIdentity, request: LogRequest): Promise<CommitSummary[]> {
  const args = ['log', `--max-count=${String(request.limit)}`, COMMIT_FORMAT]
  if (request.all === true) args.push('--all')
  if (request.author !== undefined && request.author.length > 0) args.push(`--author=${request.author}`)
  args.push(request.ref === undefined ? 'HEAD' : assertRevision(request.ref, 'ref'))
  if (request.path !== undefined && request.path.length > 0) args.push('--', request.path)
  const stdout = await git.text(repo.worktree, args, request.signal === undefined ? {} : { signal: request.signal })
  return parseLog(stdout, { parents: true })
}

/**
 * Read one repository's branches.
 * @param git - the bounded runner.
 * @param repo - the repository to read.
 * @param options - whether to include remote-tracking branches, plus cancellation.
 * @returns local branches first, then remote ones, each in git's order.
 */
export async function readBranches(
  git: Git,
  repo: RepoIdentity,
  options: { includeRemote?: boolean, signal?: AbortSignal } = {},
): Promise<BranchSummary[]> {
  const refs = ['refs/heads']
  if (options.includeRemote === true) refs.push('refs/remotes')
  const stdout = await git.text(repo.worktree, ['for-each-ref', BRANCH_FORMAT, ...refs], options.signal === undefined ? {} : { signal: options.signal })
  // `origin/HEAD` is a symbolic ref, not a branch: it would otherwise show up as
  // a second way to name the default remote branch.
  return parseBranches(stdout).filter(branch => !(branch.local === false && branch.name.endsWith('/HEAD')))
}

/**
 * Read one repository's remotes.
 * @param git - the bounded runner.
 * @param repo - the repository to read.
 * @param signal - cancellation.
 * @returns every configured remote.
 */
export async function readRemotes(git: Git, repo: RepoIdentity, signal?: AbortSignal): Promise<RemoteSummary[]> {
  const stdout = await git.text(repo.worktree, ['remote', '-v'], signal === undefined ? {} : { signal })
  return parseRemotes(stdout)
}

/** How one diff read is bounded and addressed. */
export interface DiffRequest {
  /** Which comparison to make. */
  scope: DiffScope
  /** The revision or range the scope names. */
  ref?: string
  /** Pathspecs, relative to the repository root. */
  paths?: string[]
  /** Context lines, defaulting to 3. */
  context?: number
  /** Bytes of patch text to keep. */
  maxBytes: number
  /** Cancellation. */
  signal?: AbortSignal
}

/**
 * Build the arguments that select one diff, without the output-shaping flags.
 *
 * The same selector is used for the patch, the file list, and the totals, so the
 * three can never describe different comparisons. Pathspecs are not part of it:
 * every caller appends the same `-- <paths>` tail.
 * @param request - the scope and what it names.
 * @returns the command to run and the arguments that address the comparison.
 */
function diffSelector(request: DiffRequest): { command: 'diff' | 'show', args: string[] } {
  switch (request.scope) {
    case 'staged':
      return { command: 'diff', args: ['--cached'] }
    case 'working':
      return { command: 'diff', args: [] }
    case 'commit': {
      const ref = assertRevision(request.ref ?? 'HEAD', 'ref')
      // `show` prints the commit header unless told not to; the header belongs
      // to `git_show`, so this read asks for the patch alone.
      return { command: 'show', args: ['--format=', ref] }
    }
    case 'range': {
      const ref = assertRevision(request.ref ?? '', 'ref')
      if (!ref.includes('..')) throw new Error('a range diff needs a revision range, such as main...feature')
      return { command: 'diff', args: [ref] }
    }
  }
}

/**
 * Read one repository's diff.
 * @param git - the bounded runner.
 * @param repo - the repository to read.
 * @param request - the comparison, its bounds, and cancellation.
 * @returns the patch, the file list, and the line totals.
 */
export async function readDiff(git: Git, repo: RepoIdentity, request: DiffRequest): Promise<DiffPayload> {
  if (repo.bare) throw new Error(`"${repo.name}" is a bare repository, so it has no working tree to diff`)
  const selector = diffSelector(request)
  const context = Math.max(0, Math.min(50, request.context ?? 3))
  const common = ['--no-ext-diff', '--no-color', '-M', `-U${String(context)}`]
  const paths = request.paths ?? []
  const withPaths = paths.length === 0 ? [] : ['--', ...paths]
  const options = request.signal === undefined ? {} : { signal: request.signal }
  const summary = await statusSummary(git, repo, request.signal)

  const patchOutcome = await git.run(repo.worktree, [selector.command, ...selector.args, ...common, ...withPaths], {
    ...options,
    maxBytes: request.maxBytes,
  })
  if (patchOutcome.timedOut) throw new GitError('the diff did not finish before the deadline', patchOutcome)
  if (patchOutcome.code !== 0) await failure(patchOutcome)

  const names = await git.text(repo.worktree, [
    selector.command, ...selector.args, '--no-ext-diff', '-M', '--name-status', '-z', ...withPaths,
  ], options)
  const totals = await git.text(repo.worktree, [
    selector.command, ...selector.args, '--no-ext-diff', '-M', '--shortstat', ...withPaths,
  ], options)

  const files: DiffFile[] = parseNameStatusZ(names)
  const parsed = parseShortStat(totals)
  const patch = patchOutcome.stdout
  return {
    repo: summary,
    scope: request.scope,
    ...request.ref === undefined ? {} : { ref: request.ref },
    files,
    additions: parsed.additions,
    deletions: parsed.deletions,
    patch: patchOutcome.truncated ? `${patch}\n… patch cut at ${String(request.maxBytes)} bytes` : patch,
    truncated: patchOutcome.truncated,
  }
}

/** One commit, with the paths it changed. */
export interface CommitRead {
  /** The commit itself. */
  commit: CommitSummary
  /** Paths the commit changed, as the commit itself introduced them. */
  files: DiffFile[]
}

/**
 * Read one commit's metadata and the paths it changed.
 * @param git - the bounded runner.
 * @param repo - the repository to read.
 * @param ref - the commit to read.
 * @param signal - cancellation.
 * @returns the commit and its changed paths.
 */
export async function readCommit(git: Git, repo: RepoIdentity, ref: string, signal?: AbortSignal): Promise<CommitRead> {
  const revision = assertRevision(ref, 'ref')
  const options = signal === undefined ? {} : { signal }
  const stdout = await git.text(repo.worktree, ['show', '-s', COMMIT_FORMAT, revision], options)
  const [commit] = parseLog(stdout, { parents: true })
  if (commit === undefined) throw new Error(`"${revision}" is not a commit this repository can show`)
  const names = await git.text(repo.worktree, [
    'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-z', commit.hash,
  ], options)
  return { commit, files: parseNameStatusZ(names) }
}

/**
 * Read the patch one commit introduced.
 * @param git - the bounded runner.
 * @param repo - the repository to read.
 * @param ref - the commit to read.
 * @param maxBytes - bytes of patch text to keep.
 * @param signal - cancellation.
 * @returns the patch and whether it was cut.
 */
export async function readCommitPatch(
  git: Git, repo: RepoIdentity, ref: string, maxBytes: number, signal?: AbortSignal,
): Promise<{ patch: string, truncated: boolean }> {
  const revision = assertRevision(ref, 'ref')
  const outcome = await git.run(repo.worktree, [
    'show', '--format=', '--no-ext-diff', '--no-color', '-M', revision,
  ], { maxBytes, ...signal === undefined ? {} : { signal } })
  if (outcome.code !== 0) await failure(outcome)
  return {
    patch: outcome.truncated ? `${outcome.stdout}\n… patch cut at ${String(maxBytes)} bytes` : outcome.stdout,
    truncated: outcome.truncated,
  }
}

/** How one staging operation is addressed. */
export interface StageRequest {
  /** What to do. */
  mode: 'stage' | 'unstage' | 'discard'
  /** Pathspecs, relative to the repository root. */
  paths?: string[]
  /** Stage every change, including untracked files. */
  all?: boolean
  /** Cancellation. */
  signal?: AbortSignal
}

/**
 * Stage, unstage, or discard changes in one working tree.
 *
 * `discard` has no "all" form on purpose: losing every unstaged edit in a
 * repository is not something a caller should be able to ask for with one
 * boolean, so the paths have to be named.
 * @param git - the bounded runner.
 * @param repo - the repository to change.
 * @param request - the operation and its paths.
 * @returns the status the change left behind.
 */
export async function applyStage(git: Git, repo: RepoIdentity, request: StageRequest): Promise<RepoStatus> {
  if (repo.bare) throw new Error(`"${repo.name}" is a bare repository, so it has no working tree to stage in`)
  const paths = (request.paths ?? []).filter(path => path.length > 0)
  if (request.mode === 'discard' && request.all === true) {
    throw new Error('discarding every change at once is not supported: name the paths to discard')
  }
  if (paths.length === 0 && request.all !== true) throw new Error('name at least one path, or pass all: true')
  const options = {
    // A mutating command needs the index lock the read path deliberately avoids.
    env: { GIT_OPTIONAL_LOCKS: '1' },
    ...request.signal === undefined ? {} : { signal: request.signal },
  }
  if (request.mode === 'stage') {
    await git.ok(repo.worktree, request.all === true
      ? ['add', '--all']
      : ['add', '--', ...paths], options)
  } else if (request.mode === 'unstage') {
    // A branch with no commit yet has no HEAD to restore from, and `restore
    // --staged` refuses there; `rm --cached` is what unstages in that state.
    const head = await git.run(repo.worktree, ['rev-parse', '--verify', '--quiet', 'HEAD'], options)
    if (head.code !== 0) {
      await git.ok(repo.worktree, request.all === true
        ? ['rm', '--cached', '-r', '--ignore-unmatch', '--', '.']
        : ['rm', '--cached', '-r', '--ignore-unmatch', '--', ...paths], options)
    } else {
      await git.ok(repo.worktree, request.all === true
        ? ['restore', '--staged', '--', '.']
        : ['restore', '--staged', '--', ...paths], options)
    }
  } else {
    await git.ok(repo.worktree, ['restore', '--worktree', '--', ...paths], options)
  }
  return await readStatus(git, repo, request.signal === undefined ? {} : { signal: request.signal })
}

/** How one commit is made. */
export interface CommitRequest {
  /** The commit message, used as the whole message. */
  message: string
  /** Stage every tracked change first. */
  all?: boolean
  /** Pathspecs to commit, instead of the whole staged tree. */
  paths?: string[]
  /** Cancellation. */
  signal?: AbortSignal
}

/**
 * Create one commit from the staged changes.
 * @param git - the bounded runner.
 * @param repo - the repository to commit in.
 * @param request - the message and what to include.
 * @returns the commit that was created, with the paths it changed.
 * @throws {Error} when the message is empty or git refuses.
 */
export async function createCommit(git: Git, repo: RepoIdentity, request: CommitRequest): Promise<CommitRead> {
  if (repo.bare) throw new Error(`"${repo.name}" is a bare repository, so it has no working tree to commit`)
  const message = request.message.trim()
  if (message.length === 0) throw new Error('a commit needs a message')
  const paths = (request.paths ?? []).filter(path => path.length > 0)
  const args = ['commit', '--file=-']
  if (request.all === true) args.push('--all')
  if (paths.length > 0) args.push('--', ...paths)
  await git.ok(repo.worktree, args, {
    input: `${message}\n`,
    env: { GIT_OPTIONAL_LOCKS: '1' },
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
  const head = stripEol(await git.text(repo.worktree, ['rev-parse', '--short', 'HEAD'], request.signal === undefined ? {} : { signal: request.signal }))
  return await readCommit(git, repo, head, request.signal)
}

/** How one branch switch is made. */
export interface SwitchRequest {
  /** The branch or commit to switch to. */
  branch: string
  /** Create the branch first. */
  create?: boolean
  /** Where a created branch starts. */
  startPoint?: string
  /** Switch to a commit rather than a branch. */
  detach?: boolean
  /** Cancellation. */
  signal?: AbortSignal
}

/**
 * Switch one working tree to another branch, creating it when asked.
 * @param git - the bounded runner.
 * @param repo - the repository to switch.
 * @param request - the branch and how it is reached.
 * @returns the status the switch left behind.
 */
export async function switchBranch(git: Git, repo: RepoIdentity, request: SwitchRequest): Promise<RepoStatus> {
  if (repo.bare) throw new Error(`"${repo.name}" is a bare repository, so it has no working tree to switch`)
  const branch = request.branch.trim()
  if (branch.length === 0) throw new Error('a branch switch needs a branch name')
  if (branch.startsWith('-')) throw new Error(`the branch "${branch}" must not begin with "-"`)
  const options = {
    env: { GIT_OPTIONAL_LOCKS: '1' },
    ...request.signal === undefined ? {} : { signal: request.signal },
  }
  const startPoint = request.startPoint === undefined || request.startPoint.trim().length === 0
    ? undefined
    : assertRevision(request.startPoint, 'start point')
  if (request.detach === true) {
    await git.ok(repo.worktree, ['switch', '--detach', branch], options)
  } else if (request.create === true) {
    await git.ok(repo.worktree, ['switch', '--create', branch, ...startPoint === undefined ? [] : [startPoint]], options)
  } else {
    await git.ok(repo.worktree, ['switch', '--', branch], options)
  }
  return await readStatus(git, repo, request.signal === undefined ? {} : { signal: request.signal })
}

/**
 * The most specific directory of a list that exists, for a caller that named a
 * path which may have been removed.
 * @param candidates - directories to try, most specific first.
 * @returns the first directory that exists, or undefined.
 */
export async function firstExistingDirectory(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return resolve(candidate)
  }
  return undefined
}

/** Whether a path is absolute, exposed so the tools resolve paths one way. */
export { isAbsolute }
