/**
 * The model-facing tools: discover repositories, read status and history, read a
 * diff, and — when the deployment allows it — stage, commit, and switch.
 *
 * Every mutating tool is registered only when its switch is on, so the surface
 * the model is offered is the surface this deployment will actually perform.
 * Reads resolve the repository afresh on every call, so a directory the session
 * changed into a moment ago is the one a call addresses.
 *
 * @module dsh-git/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectValueSchemaSpec } from '@deepseek-ai/dsh-tools/src/schema.ts'
import type {
  BranchSummary, CommitSummary, DiffFile, DiffPayload, DiffScope, RepoStatus, RepoSummary,
} from './contract.ts'
import type { Git } from './git.ts'
import {
  applyStage, createCommit, listRepos, readBranches, readCommit, readCommitPatch, readDiff,
  readLog, readRemotes, readStatus, switchBranch,
} from './git.ts'
import type { RepoIdentity } from './contract.ts'

/** What one call receives from the host, beyond its own arguments. */
export interface CallContext {
  /** Cancellation the tool body must observe. */
  signal: AbortSignal
  /** The calling session, when the host gives one. */
  agent?: unknown
}

/** What the tools need from the plugin, resolved once at registration. */
export interface GitToolsFace {
  /** The bounded runner every call goes through. */
  git: Git
  /** Resolve one directory to the repository that owns it. */
  identify: (directory: string, signal?: AbortSignal) => Promise<RepoIdentity>
  /**
   * Resolve what a call named as its repository: a path — absolute or relative
   * to the session directory — or the name of a repository under the workspace
   * root.
   */
  resolveNamed: (named: string, sessionDirectory: string | undefined) => Promise<RepoIdentity>
  /** Resolve one directory a call named, absolute or relative to the session. */
  resolvePath: (path: string, sessionDirectory: string | undefined) => Promise<string>
  /** Summarize an already resolved repository. */
  summary: (repo: RepoIdentity, signal?: AbortSignal) => Promise<RepoSummary>
  /** The directory a repository name is resolved against when a call names none. */
  sessionDirectory: (call: CallContext) => Promise<string | undefined>
  /** The root a discovery call scans when it names none. */
  discoveryRoot: (call: CallContext) => Promise<string>
  /** Directory levels a discovery call scans when it names none. */
  discoveryDepth: number
  /** Repositories a discovery call returns when it names none. */
  discoveryLimit: number
  /** Bytes of patch text one tool read keeps. */
  maxPatchBytes: number
  /** Commits one log read returns when the call names no limit. */
  logLimit: number
  /** Paths one status read lists. */
  maxFiles: number
  /** Whether staging is allowed in this deployment. */
  allowStage: boolean
  /** Whether committing is allowed in this deployment. */
  allowCommit: boolean
  /** Whether switching branches is allowed in this deployment. */
  allowSwitch: boolean
}

/** The repository parameter every tool shares. */
const REPO_PARAMETER = {
  type: 'string' as const,
  description: 'Repository to address: an absolute path, a path relative to the session directory, or a repository name found under the workspace root. Defaults to the session directory, which may be any directory inside the repository.',
}

/** A pathspec list, shared by the diff and the staging tools. */
const PATHS_PARAMETER = {
  type: 'array' as const,
  items: { type: 'string' as const },
  description: 'Paths relative to the repository root. Omit for the whole repository.',
}

/** One repository, as every listing answers it. */
const REPO_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    path: { type: 'string' as const, required: true, description: 'Absolute worktree path, or the git directory of a bare repository.' },
    name: { type: 'string' as const, required: true },
    branch: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }], required: true, description: 'Current branch, or null on a detached HEAD.' },
    detached: { type: 'boolean' as const, required: true },
    head: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }], required: true, description: 'Abbreviated HEAD commit, or null before the first one.' },
    upstream: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }], required: true },
    ahead: { type: 'integer' as const, required: true },
    behind: { type: 'integer' as const, required: true },
    staged: { type: 'integer' as const, required: true },
    unstaged: { type: 'integer' as const, required: true },
    untracked: { type: 'integer' as const, required: true },
    conflicted: { type: 'integer' as const, required: true },
    dirty: { type: 'boolean' as const, required: true },
  },
} satisfies ObjectValueSchemaSpec

/** One changed path in a working tree. */
const STATUS_FILE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    path: { type: 'string' as const, required: true },
    origPath: { type: 'string' as const, description: 'Previous path, for a rename or a copy.' },
    index: { type: 'string' as const, required: true, description: 'Index status letter: A, M, D, R, C, U, or . for unchanged.' },
    worktree: { type: 'string' as const, required: true, description: 'Worktree status letter, from the same alphabet.' },
    kind: {
      type: 'string' as const,
      required: true,
      enum: ['changed', 'renamed', 'copied', 'unmerged', 'untracked', 'ignored'],
      description: 'What kind of entry this is.',
    },
  },
} satisfies ObjectValueSchemaSpec

/** One branch. */
const BRANCH_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    name: { type: 'string' as const, required: true },
    local: { type: 'boolean' as const, required: true },
    current: { type: 'boolean' as const, required: true },
    upstream: { oneOf: [{ type: 'string' as const }, { type: 'null' as const }], required: true },
    ahead: { type: 'integer' as const, required: true },
    behind: { type: 'integer' as const, required: true },
    track: {
      type: 'string' as const,
      required: true,
      enum: ['tracked', 'gone', 'untracked'],
      description: 'How the branch stands to its upstream.',
    },
    sha: { type: 'string' as const, required: true },
    date: { type: 'string' as const, required: true },
    subject: { type: 'string' as const, required: true },
  },
} satisfies ObjectValueSchemaSpec

/** One commit. */
const COMMIT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    hash: { type: 'string' as const, required: true },
    short: { type: 'string' as const, required: true },
    author: { type: 'string' as const, required: true },
    email: { type: 'string' as const, required: true },
    date: { type: 'string' as const, required: true, description: 'Author date, ISO 8601 with the author offset.' },
    timestamp: { type: 'integer' as const, required: true },
    subject: { type: 'string' as const, required: true },
    refs: { type: 'array' as const, required: true, items: { type: 'string' as const }, description: 'Ref names pointing at this commit, as git decorates them.' },
    parents: { type: 'array' as const, required: true, items: { type: 'string' as const } },
  },
} satisfies ObjectValueSchemaSpec

/** One changed path in a diff. */
const DIFF_FILE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    status: { type: 'string' as const, required: true, description: 'A, M, D, R100 (renamed), C100 (copied), or U (unmerged).' },
    path: { type: 'string' as const, required: true },
    origPath: { type: 'string' as const, description: 'Previous path, for a rename or a copy.' },
  },
} satisfies ObjectValueSchemaSpec

/** One remote. */
const REMOTE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    name: { type: 'string' as const, required: true },
    fetch: { type: 'string' as const, required: true },
    push: { type: 'string' as const, required: true },
  },
} satisfies ObjectValueSchemaSpec

/** One repository's status, as a staging or switching call answers it. */
const STATUS_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    repo: { ...REPO_SCHEMA, required: true },
    files: { type: 'array' as const, required: true, items: STATUS_FILE_SCHEMA },
    filesTruncated: { type: 'boolean' as const, required: true },
  },
} satisfies ObjectValueSchemaSpec

/** A one-line obligation: the model reads it, so it carries the count and the bound. */
function dirtyPhrase(repo: RepoSummary): string {
  if (!repo.dirty) return 'clean'
  const parts: string[] = []
  if (repo.staged > 0) parts.push(`${String(repo.staged)} staged`)
  if (repo.unstaged > 0) parts.push(`${String(repo.unstaged)} unstaged`)
  if (repo.untracked > 0) parts.push(`${String(repo.untracked)} untracked`)
  if (repo.conflicted > 0) parts.push(`${String(repo.conflicted)} conflicted`)
  return parts.join(', ')
}

/** The branch a summary addresses, spelled the way a person reads it. */
function branchPhrase(repo: RepoSummary): string {
  if (repo.detached) return `detached at ${repo.head ?? 'an unknown commit'}`
  const position = repo.ahead > 0 || repo.behind > 0
    ? ` (${repo.ahead > 0 ? `ahead ${String(repo.ahead)}` : ''}${repo.ahead > 0 && repo.behind > 0 ? ', ' : ''}${repo.behind > 0 ? `behind ${String(repo.behind)}` : ''})`
    : ''
  return `${repo.branch ?? 'unborn branch'}${repo.upstream === null ? '' : ` 鈫?${repo.upstream}`}${position}`
}

/**
 * One status, as text.
 *
 * The parameter is the shape the renderer reads, not `RepoStatus`: the value the
 * tool answers is the one its output schema declares, and that schema spells a
 * status kind as a string. Reading only those fields is what lets the renderer
 * take either without a cast.
 * @param status - the status to spell.
 * @param limit - paths to list.
 * @returns the text.
 */
export function statusText(
  status: {
    repo: RepoSummary
    files: readonly { path: string, origPath?: string, index: string, worktree: string, kind: string }[]
    filesTruncated: boolean
  },
  limit = 50,
): string {
  const lines = [
    `${status.repo.name} 路 ${branchPhrase(status.repo)} 路 ${dirtyPhrase(status.repo)}`,
  ]
  if (status.files.length === 0) {
    lines.push('The working tree is clean.')
    return lines.join('\n')
  }
  for (const file of status.files.slice(0, limit)) {
    const moved = file.origPath === undefined ? '' : ` 鈫?${file.origPath}`
    const flags = file.kind === 'untracked' ? '??' : `${file.index}${file.worktree}`
    lines.push(`${flags}  ${file.path}${moved}`)
  }
  if (status.files.length > limit || status.filesTruncated) {
    lines.push(`… ${String(status.files.length - limit)} more path(s) not shown`)
  }
  return lines.join('\n')
}

/** One commit, as text. */
function commitText(commit: CommitSummary): string {
  const refs = commit.refs.length === 0 ? '' : ` (${commit.refs.join(', ')})`
  return `${commit.short} ${commit.date.slice(0, 10)} ${commit.author}: ${commit.subject}${refs}`
}

/** One changed path in a diff, as text. */
function diffFileText(file: DiffFile): string {
  return file.origPath === undefined ? `${file.status} ${file.path}` : `${file.status} ${file.origPath} 鈫?${file.path}`
}

/** A value that survives JSON, as the session log stores presentation metadata. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** The metadata the client's row reads for one git call. */
function meta(variant: string, extra: { [key: string]: JsonValue }): { [key: string]: JsonValue } {
  return { card: 'git', variant, ...extra }
}

/**
 * Register every tool this deployment allows.
 * @param ctx - the plugin context.
 * @param face - the runner and the bounds each call runs under.
 */
export function applyGitTools(ctx: Context, face: GitToolsFace): void {
  const { git } = face

  /**
   * Resolve the repository one call addresses.
   * @param call - the call's cancellation and session.
   * @param named - the repository the call named, if any.
   * @returns the repository identity.
   * @throws {Error} when nothing resolves to a repository.
   */
  const target = async (call: CallContext, named?: string): Promise<RepoIdentity> => {
    const sessionDirectory = await face.sessionDirectory(call)
    if (named !== undefined && named.trim().length > 0) {
      const value = named.trim()
      const direct = await face.resolveNamed(value, sessionDirectory)
      return direct
    }
    if (sessionDirectory !== undefined) {
      return await face.identify(sessionDirectory, call.signal)
    }
    throw new Error('this call names no repository, and the session has no directory; pass repo with the path of a checkout')
  }

  ctx.tools.register(defineTool({
    name: 'git_repos',
    description: 'List the git repositories under a directory, with each one\'s branch, upstream position, and change counts. '
      + 'Scans the tree breadth-first and skips dependency and build directories; reads each repository\'s status, so a large workspace costs one command per checkout. '
      + 'Use it to find which checkout a task belongs to before reading anything else.',
    parameters: {
      root: { type: 'string', description: 'Directory to scan. Defaults to the session directory, or to the workspace root when the session has none.' },
      depth: { type: 'integer', description: 'How many directory levels below the root to scan. Defaults to 4.' },
      limit: { type: 'integer', description: 'Stop after this many repositories. Defaults to the deployment\'s bound.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          repos: { type: 'array', required: true, items: REPO_SCHEMA },
          truncated: { type: 'boolean', required: true, description: 'True when the repository bound stopped the scan.' },
          failures: { type: 'array', required: true, items: { type: 'string' }, description: 'Directories that looked like a repository but whose status could not be read.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.repos.length === 0
          ? `No git repository was found under ${value.root}.`
          : [
            `${String(value.repos.length)} repositor${value.repos.length === 1 ? 'y' : 'ies'} under ${value.root}:`,
            ...value.repos.map(repo => `${repo.name}  ${branchPhrase(repo)}  ${dirtyPhrase(repo)}  ${repo.path}`),
            ...value.failures.length === 0 ? [] : [`unreadable: ${value.failures.join('; ')}`],
          ].join('\n'),
      }],
      presentationMeta: (_args, value) => meta('repos', {
        root: value.root,
        total: value.repos.length,
        truncated: value.truncated,
        repos: value.repos.slice(0, 20).map(repo => ({
          name: repo.name, path: repo.path, branch: repo.branch, ahead: repo.ahead, behind: repo.behind,
          changes: repo.staged + repo.unstaged + repo.untracked + repo.conflicted,
        })),
      }),
    },
    async execute(args, exec) {
      const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
      const root = args.root === undefined || args.root.trim().length === 0
        ? await face.discoveryRoot(call)
        : await face.resolvePath(args.root.trim(), await face.sessionDirectory(call))
      const listed = await listRepos(git, root, {
        maxDepth: args.depth ?? face.discoveryDepth,
        maxRepos: args.limit ?? face.discoveryLimit,
        maxFiles: 0,
        signal: exec.signal,
      })
      const repos: RepoSummary[] = listed.repos
      return { root: listed.root, repos, truncated: listed.truncated, failures: listed.failures }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_status',
    description: 'Read one repository\'s status: the current branch (or detached HEAD), its upstream position, and every changed path with its staged and unstaged letters. '
      + 'This is the read to make before staging or committing, because it is the one that says what would be included.',
    parameters: {
      repo: REPO_PARAMETER,
      files: { type: 'integer', description: 'Maximum paths to list. Defaults to the deployment\'s bound.' },
    },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: statusText(value) }],
      presentationMeta: (_args, value) => meta('status', {
        repo: value.repo.name,
        path: value.repo.path,
        branch: value.repo.branch,
        detached: value.repo.detached,
        upstream: value.repo.upstream,
        ahead: value.repo.ahead,
        behind: value.repo.behind,
        staged: value.repo.staged,
        unstaged: value.repo.unstaged,
        untracked: value.repo.untracked,
        conflicted: value.repo.conflicted,
        total: value.files.length,
        truncated: value.filesTruncated,
        files: value.files.slice(0, 20).map(file => ({
          path: file.path,
          ...file.origPath === undefined ? {} : { origPath: file.origPath },
          index: file.index,
          worktree: file.worktree,
          kind: file.kind,
        })),
      }),
    },
    async execute(args, exec) {
      const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
      const repo = await target(call, args.repo)
      return await readStatus(git, repo, {
        maxFiles: args.files ?? face.maxFiles,
        signal: exec.signal,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_log',
    description: 'Read a repository\'s recent commits, newest first: object name, author, date, subject, and the refs that point at each one. '
      + 'Accepts a revision or range and a path filter, so it can answer "what changed here lately" as well as "what is the history".',
    parameters: {
      repo: REPO_PARAMETER,
      limit: { type: 'integer', description: 'Commits to return. Defaults to the deployment\'s bound; a large number costs tokens, not time.' },
      ref: { type: 'string', description: 'Revision or range to walk, such as main, HEAD~5, or main...feature. Defaults to HEAD.' },
      path: { type: 'string', description: 'Only commits touching this path.' },
      author: { type: 'string', description: 'Only commits whose author matches this text.' },
      all: { type: 'boolean', description: 'Walk every ref instead of only the named one. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { ...REPO_SCHEMA, required: true },
          commits: { type: 'array', required: true, items: COMMIT_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.commits.length === 0
          ? `${value.repo.name} has no commits on that revision.`
          : [`${value.repo.name}:`, ...value.commits.map(commitText)].join('\n'),
      }],
      presentationMeta: (_args, value) => meta('log', {
        repo: value.repo.name,
        total: value.commits.length,
        truncated: false,
        commits: value.commits.slice(0, 15).map(commit => ({
          short: commit.short, subject: commit.subject, author: commit.author, date: commit.date, refs: commit.refs,
        })),
      }),
    },
    async execute(args, exec) {
      const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
      const repo = await target(call, args.repo)
      const commits = await readLog(git, repo, {
        limit: Math.max(1, Math.min(500, args.limit ?? face.logLimit)),
        ...args.ref === undefined ? {} : { ref: args.ref },
        ...args.path === undefined ? {} : { path: args.path },
        ...args.author === undefined ? {} : { author: args.author },
        ...args.all === true ? { all: true } : {},
        signal: exec.signal,
      })
      const summary = await face.summary(repo, exec.signal)
      return { repo: summary, commits }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_diff',
    description: 'Read the patch one comparison covers, with the changed paths and line totals. '
      + 'scope "working" compares the working tree with the index, "staged" compares the index with HEAD, "commit" shows one commit, and "range" compares two revisions. '
      + 'The patch is cut at the deployment\'s byte bound; the totals still describe the whole change.',
    parameters: {
      repo: REPO_PARAMETER,
      scope: { type: 'string', description: 'working, staged, commit, or range. Defaults to working.' },
      ref: { type: 'string', description: 'The revision for scope commit, or the range (such as main...feature) for scope range.' },
      paths: PATHS_PARAMETER,
      context: { type: 'integer', description: 'Lines of context around each hunk. Defaults to 3.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { ...REPO_SCHEMA, required: true },
          scope: {
            type: 'string',
            required: true,
            enum: ['working', 'staged', 'commit', 'range'],
            description: 'Which comparison this diff covers.',
          },
          ref: { type: 'string' },
          files: { type: 'array', required: true, items: DIFF_FILE_SCHEMA },
          additions: { type: 'integer', required: true },
          deletions: { type: 'integer', required: true },
          patch: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.repo.name} 路 ${value.scope}${value.ref === undefined ? '' : ` ${value.ref}`} 路 ${String(value.files.length)} file(s), +${String(value.additions)} 鈭?{String(value.deletions)}${value.truncated ? ' (patch cut)' : ''}`,
          ...value.files.map(diffFileText),
          value.patch.length === 0 ? 'No textual change.' : value.patch,
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => meta('diff', {
        repo: value.repo.name,
        scope: value.scope,
        ...value.ref === undefined ? {} : { ref: value.ref },
        total: value.files.length,
        additions: value.additions,
        deletions: value.deletions,
        truncated: value.truncated,
        files: value.files.slice(0, 20).map(file => ({
          status: file.status,
          path: file.path,
          ...file.origPath === undefined ? {} : { origPath: file.origPath },
        })),
      }),
    },
    async execute(args, exec) {
      const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
      const repo = await target(call, args.repo)
      const scope = (args.scope ?? 'working') as DiffScope
      if (!['working', 'staged', 'commit', 'range'].includes(scope)) {
        throw new Error(`unknown diff scope "${String(args.scope)}": use working, staged, commit, or range`)
      }
      const payload: DiffPayload = await readDiff(git, repo, {
        scope,
        ...args.ref === undefined ? {} : { ref: args.ref },
        ...args.paths === undefined ? {} : { paths: args.paths },
        ...args.context === undefined ? {} : { context: args.context },
        maxBytes: face.maxPatchBytes,
        signal: exec.signal,
      })
      // An empty comparison is an answer, not an error: the model asked what
      // changed, and nothing did.
      return payload
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_show',
    description: 'Show one commit: its metadata, the paths it changed, and — unless patch is false — the patch it introduced. '
      + 'A merge commit lists no changed paths of its own, which is what git itself reports for a merge.',
    parameters: {
      repo: REPO_PARAMETER,
      ref: { type: 'string', required: true, description: 'Commit to show, such as HEAD, HEAD~2, or an object name.' },
      patch: { type: 'boolean', description: 'Include the patch. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { ...REPO_SCHEMA, required: true },
          commit: { ...COMMIT_SCHEMA, required: true },
          files: { type: 'array', required: true, items: DIFF_FILE_SCHEMA },
          patch: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.repo.name}: ${commitText(value.commit)}`,
          ...value.files.map(diffFileText),
          ...value.patch === undefined ? [] : ['', value.patch],
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => meta('commit', {
        repo: value.repo.name,
        short: value.commit.short,
        subject: value.commit.subject,
        author: value.commit.author,
        date: value.commit.date,
        total: value.files.length,
        truncated: value.truncated ?? false,
        files: value.files.slice(0, 20).map(file => ({
          status: file.status,
          path: file.path,
          ...file.origPath === undefined ? {} : { origPath: file.origPath },
        })),
      }),
    },
    async execute(args, exec) {
      const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
      const repo = await target(call, args.repo)
      const read = await readCommit(git, repo, args.ref, exec.signal)
      const summary = await face.summary(repo, exec.signal)
      if (args.patch === false) return { repo: summary, commit: read.commit, files: read.files }
      const patch = await readCommitPatch(git, repo, args.ref, face.maxPatchBytes, exec.signal)
      return { repo: summary, commit: read.commit, files: read.files, patch: patch.patch, truncated: patch.truncated }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_branches',
    description: 'List a repository\'s branches: the current one, whether each tracks an upstream, and how far ahead or behind that upstream it sits. '
      + 'Remote-tracking branches are included only when remote is true.',
    parameters: {
      repo: REPO_PARAMETER,
      remote: { type: 'boolean', description: 'Include remote-tracking branches. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { ...REPO_SCHEMA, required: true },
          current: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          branches: { type: 'array', required: true, items: BRANCH_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `${value.repo.name} 路 on ${value.current ?? 'a detached HEAD'}`,
          ...value.branches.map(branch => `${branch.current ? '*' : ' '} ${branch.name}${branch.upstream === null ? '' : ` 鈫?${branch.upstream}`}${branch.track === 'gone' ? ' [gone]' : branch.ahead > 0 || branch.behind > 0 ? ` [${branch.ahead > 0 ? `ahead ${String(branch.ahead)}` : ''}${branch.ahead > 0 && branch.behind > 0 ? ', ' : ''}${branch.behind > 0 ? `behind ${String(branch.behind)}` : ''}]` : ''}  ${branch.subject}`),
        ].join('\n'),
      }],
      presentationMeta: (_args, value) => meta('branches', {
        repo: value.repo.name,
        current: value.current,
        total: value.branches.length,
        truncated: false,
        branches: value.branches.slice(0, 20).map(branch => ({
          name: branch.name, current: branch.current, local: branch.local,
          ahead: branch.ahead, behind: branch.behind, track: branch.track,
        })),
      }),
    },
    async execute(args, exec) {
      const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
      const repo = await target(call, args.repo)
      const branches: BranchSummary[] = await readBranches(git, repo, {
        ...args.remote === true ? { includeRemote: true } : {},
        signal: exec.signal,
      })
      const summary = await face.summary(repo, exec.signal)
      return { repo: summary, current: summary.branch, branches }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_remotes',
    description: 'List a repository\'s configured remotes with their fetch and push URLs. Reads configuration only: no network access is performed.',
    parameters: { repo: REPO_PARAMETER },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repo: { ...REPO_SCHEMA, required: true },
          remotes: { type: 'array', required: true, items: REMOTE_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.remotes.length === 0
          ? `${value.repo.name} has no remotes configured.`
          : value.remotes.map(remote => `${remote.name}  fetch: ${remote.fetch}${remote.push === remote.fetch ? '' : `  push: ${remote.push}`}`).join('\n'),
      }],
      presentationMeta: (_args, value) => meta('remotes', {
        repo: value.repo.name,
        total: value.remotes.length,
        truncated: false,
        remotes: value.remotes.slice(0, 20),
      }),
    },
    async execute(args, exec) {
      const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
      const repo = await target(call, args.repo)
      const remotes = await readRemotes(git, repo, exec.signal)
      const summary = await face.summary(repo, exec.signal)
      return { repo: summary, remotes }
    },
  }))

  if (face.allowStage) {
    ctx.tools.register(defineTool({
      name: 'git_stage',
      description: 'Stage, unstage, or discard paths in one working tree. '
        + 'mode "stage" adds the named paths (or everything, with all: true, including untracked files); "unstage" takes them back out of the index; "discard" reverts the working tree for the named paths and cannot be undone. '
        + 'The answer is the status the change left behind, so the next step never has to guess.',
      parameters: {
        repo: REPO_PARAMETER,
        mode: { type: 'string', description: 'stage, unstage, or discard. Defaults to stage.' },
        paths: PATHS_PARAMETER,
        all: { type: 'boolean', description: 'Apply to every path. Not accepted with mode discard.' },
      },
      output: {
        schema: STATUS_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: statusText(value) }],
        presentationMeta: (_args, value) => meta('action', {
          repo: value.repo.name,
          branch: value.repo.branch,
          truncated: false,
          staged: value.repo.staged,
          unstaged: value.repo.unstaged,
          untracked: value.repo.untracked,
          conflicted: value.repo.conflicted,
          dirty: value.repo.dirty,
        }),
      },
      async execute(args, exec) {
        const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
        const repo = await target(call, args.repo)
        const mode = args.mode ?? 'stage'
        if (mode !== 'stage' && mode !== 'unstage' && mode !== 'discard') {
          throw new Error(`unknown mode "${String(args.mode)}": use stage, unstage, or discard`)
        }
        return await applyStage(git, repo, {
          mode,
          ...args.paths === undefined ? {} : { paths: args.paths },
          ...args.all === true ? { all: true } : {},
          signal: exec.signal,
        })
      },
    }))
  }

  if (face.allowCommit) {
    ctx.tools.register(defineTool({
      name: 'git_commit',
      description: 'Create one commit from the staged changes, with the message used exactly as given. '
        + 'With all: true every tracked change is staged first; paths commits only the named paths. Hooks run as configured, so a failing pre-commit hook fails the call and nothing is committed. '
        + 'The answer carries the new commit and the paths it changed.',
      parameters: {
        repo: REPO_PARAMETER,
        message: { type: 'string', required: true, description: 'The commit message, used as the whole message. The first line is the subject.' },
        all: { type: 'boolean', description: 'Stage every tracked change first. Defaults to false, so only what is already staged is committed.' },
        paths: PATHS_PARAMETER,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            repo: { ...REPO_SCHEMA, required: true },
            commit: { ...COMMIT_SCHEMA, required: true },
            files: { type: 'array', required: true, items: DIFF_FILE_SCHEMA },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: [
            `${value.repo.name}: committed ${commitText(value.commit)}`,
            ...value.files.map(diffFileText),
          ].join('\n'),
        }],
        presentationMeta: (_args, value) => meta('commit', {
          repo: value.repo.name,
          short: value.commit.short,
          subject: value.commit.subject,
          author: value.commit.author,
          date: value.commit.date,
          total: value.files.length,
          truncated: false,
          files: value.files.slice(0, 20).map(file => ({
            status: file.status,
            path: file.path,
            ...file.origPath === undefined ? {} : { origPath: file.origPath },
          })),
        }),
      },
      async execute(args, exec) {
        const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
        const repo = await target(call, args.repo)
        const committed = await createCommit(git, repo, {
          message: args.message,
          ...args.all === true ? { all: true } : {},
          ...args.paths === undefined ? {} : { paths: args.paths },
          signal: exec.signal,
        })
        const summary = await face.summary(repo, exec.signal)
        return { repo: summary, commit: committed.commit, files: committed.files }
      },
    }))
  }

  if (face.allowSwitch) {
    ctx.tools.register(defineTool({
      name: 'git_switch',
      description: 'Switch one working tree to another branch, or create a branch and switch to it. '
        + 'Git refuses when the working tree has changes that would be overwritten, and that refusal is what this call reports: nothing is forced. '
        + 'Use detach: true to switch to a commit instead of a branch.',
      parameters: {
        repo: REPO_PARAMETER,
        branch: { type: 'string', required: true, description: 'Branch to switch to, or the new branch name when create is true.' },
        create: { type: 'boolean', description: 'Create the branch before switching to it. Defaults to false.' },
        start: { type: 'string', description: 'Where a created branch starts. Defaults to HEAD.' },
        detach: { type: 'boolean', description: 'Switch to the named commit with a detached HEAD. Defaults to false.' },
      },
      output: {
        schema: STATUS_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: statusText(value) }],
        presentationMeta: (_args, value) => meta('action', {
          repo: value.repo.name,
          branch: value.repo.branch,
          truncated: false,
          staged: value.repo.staged,
          unstaged: value.repo.unstaged,
          untracked: value.repo.untracked,
          conflicted: value.repo.conflicted,
          dirty: value.repo.dirty,
        }),
      },
      async execute(args, exec) {
        const call: CallContext = { signal: exec.signal, ...exec.agent === undefined ? {} : { agent: exec.agent } }
        const repo = await target(call, args.repo)
        return await switchBranch(git, repo, {
          branch: args.branch,
          ...args.create === true ? { create: true } : {},
          ...args.detach === true ? { detach: true } : {},
          ...args.start === undefined ? {} : { startPoint: args.start },
          signal: exec.signal,
        })
      },
    }))
  }
}
