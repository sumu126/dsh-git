/**
 * Host half of the git plugin.
 *
 * It owns one bounded git runner, registers the model-facing tools, and serves
 * the four reads the right-sidebar panel makes on the authenticated API channel.
 * Both faces go through the same functions, so a panel and a tool call can never
 * report two different branches for the same checkout.
 *
 * @module dsh-git
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import { isAbsolute, resolve } from 'node:path'
import {
  GIT_COMMIT_PATH, GIT_DIFF_PATH, GIT_LOG_PATH, GIT_REPOS_PATH, GIT_ROOTS_PATH, GIT_STAGE_PATH, GIT_STATUS_PATH,
  type Capabilities, type CommitAnswer, type CommitRequest, type DiffAnswer, type DiffScope, type GitLimits,
  type LogPayload, type RepoIdentity, type RepoRoot, type ReposPayload, type RootsPayload, type StageAnswer,
  type StageRequest, type StatusPayload,
} from './contract.ts'
import {
  applyStage, createCommit, directoryExists, discoverRepos, Git, identifyRepo, listRepos, readDiff, readLog,
  readStatus, summarizeRepo,
} from './git.ts'
import { applyGitTools, type CallContext } from './tools.ts'

export type { RepoSummary, RepoStatus, DiffPayload, CommitSummary, BranchSummary } from './contract.ts'

/** Stable Loader identity. */
export const name = 'dsh-git'

/** The tool registry is the one service this plugin cannot work without. */
export const inject = ['tools']

/** The composition this plugin accepts, as the host hands it over. */
export interface Config {
  /** The directory whose repositories this deployment manages; empty asks the session. */
  root: string
  /** The git executable. */
  gitCommand: string
  /** Milliseconds one git command may take before it is killed. */
  timeoutMs: number
  /** Bytes of one command's output that are kept. */
  maxOutputBytes: number
  /** Bytes of patch text one tool call keeps. */
  maxPatchBytes: number
  /** Commits `git_log` returns when the call names no limit. */
  logLimit: number
  /** Repositories one discovery call returns when it names no limit. */
  maxRepos: number
  /** Directory levels a discovery call scans. */
  maxDepth: number
  /** Paths one status read lists. */
  maxFiles: number
  /** Whether `git_stage` is registered. */
  allowStage: boolean
  /** Whether `git_commit` is registered. */
  allowCommit: boolean
  /** Whether `git_switch` is registered. */
  allowSwitch: boolean
}

/** The schema the loader validates one composition entry against. */
export const Config: z<Config> = z.object({
  /**
   * The directory whose repositories this deployment manages.
   *
   * Empty leaves it to the calling session: a tool call scans the session's own
   * directory, and the panel offers the roots it can find — the registered
   * workspaces, then the last session directory. A deployment that wants one
   * fixed root names it here.
   */
  root: z.string().default(''),
  /** The git executable. */
  gitCommand: z.string().default('git'),
  /** Milliseconds one git command may take before it is killed. */
  timeoutMs: z.number().default(30_000),
  /** Bytes of one command's output that are kept. */
  maxOutputBytes: z.number().default(262_144),
  /** Bytes of patch text one tool call keeps. */
  maxPatchBytes: z.number().default(65_536),
  /** Commits `git_log` returns when the call names no limit. */
  logLimit: z.number().default(20),
  /** Repositories one discovery call returns when it names no limit. */
  maxRepos: z.number().default(100),
  /** Directory levels a discovery call scans. */
  maxDepth: z.number().default(4),
  /** Paths one status read lists. */
  maxFiles: z.number().default(200),
  /** Whether `git_stage` is registered. */
  allowStage: z.boolean().default(true),
  /** Whether `git_commit` is registered. */
  allowCommit: z.boolean().default(true),
  /** Whether `git_switch` is registered. */
  allowSwitch: z.boolean().default(true),
})

/** One route registration the browser carrier accepts. */
interface FetchRoute {
  /** The path the route answers on. */
  path: string
  /** The methods it accepts. */
  methods: readonly string[]
  /** How the request body is delivered. */
  requestBody: 'buffered'
  /** The handler. */
  fetch: (request: Request) => Promise<Response>
}

/** The browser-connection carrier, as this plugin uses it. */
interface ConnectionHandle {
  /** The Fetch route registry. */
  fetch: {
    /** Register one route, and answer a disposer. */
    register: (route: FetchRoute) => () => void
  }
}

/** The working-directory service, as this plugin uses it. */
interface WorkingDirectoryLike {
  /**
   * The directory one session is working in.
   * @param agent - the calling session.
   * @param signal - cancellation.
   */
  ensure: (agent: unknown, signal?: AbortSignal) => Promise<string>
}

/** One workspace record, as the registry lists it. */
interface WorkspaceLike {
  /** The canonical directory the workspace owns. */
  path?: unknown
  /** Its display title. */
  title?: unknown
}

/** The workspace registry, as this plugin uses it. */
interface WorkspaceRegistryLike {
  /** The registered workspaces. */
  list: () => readonly WorkspaceLike[]
}

/** Clamp one numeric bound into an inclusive range. */
function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, Math.round(resolved)))
}

/**
 * Read one optional service without requiring it.
 * @param ctx - the plugin context.
 * @param service - the service name.
 * @returns the service, or undefined when this host does not serve it.
 */
function optionalService<T>(ctx: Context, service: string): T | undefined {
  try {
    const lookup = ctx as unknown as { get: (name: string) => unknown }
    return lookup.get(service) as T | undefined
  } catch {
    return undefined
  }
}

/**
 * Register the tools, the panel's reads, and the service seams this plugin uses.
 * @param ctx - the plugin context.
 * @param config - the composition values.
 */
export function apply(ctx: Context, config: Config): void {
  const command = (config.gitCommand ?? 'git').trim()
  if (command.length === 0) throw new Error('dsh-git: gitCommand must not be empty')
  const limits: GitLimits = {
    command,
    timeoutMs: clamp(config.timeoutMs, 30_000, 1_000, 600_000),
    maxOutputBytes: clamp(config.maxOutputBytes, 262_144, 4_096, 16_777_216),
  }
  const maxPatchBytes = clamp(config.maxPatchBytes, 65_536, 1_024, 4_194_304)
  const maxFiles = clamp(config.maxFiles, 200, 1, 5_000)
  const logLimit = clamp(config.logLimit, 20, 1, 500)
  const maxRepos = clamp(config.maxRepos, 100, 1, 1_000)
  const maxDepth = clamp(config.maxDepth, 4, 0, 12)
  const allowStage = config.allowStage !== false
  const allowCommit = config.allowCommit !== false
  const allowSwitch = config.allowSwitch !== false
  const capabilities: Capabilities = { stage: allowStage, commit: allowCommit, switch: allowSwitch }
  const git = new Git(limits)

  /** The directory the last tool call worked in, which a panel read falls back to. */
  let sessionRoot: string | undefined = config.root.trim().length > 0 ? config.root.trim() : undefined

  const workingDirectory = (): WorkingDirectoryLike | undefined =>
    optionalService<WorkingDirectoryLike>(ctx, 'workingDirectory')

  const workspaceRegistry = (): WorkspaceRegistryLike | undefined =>
    optionalService<WorkspaceRegistryLike>(ctx, 'workspaceRegistry')

  /** The directory one call works in, when the host exposes it. */
  const directoryOf = async (call: CallContext): Promise<string | undefined> => {
    const service = workingDirectory()
    if (service === undefined || call.agent === undefined) return undefined
    try {
      const directory = await service.ensure(call.agent, call.signal)
      if (directory.length > 0) sessionRoot = directory
      return directory.length === 0 ? undefined : directory
    } catch {
      return undefined
    }
  }

  /** The directory a request with no session works from. */
  const routeBase = (): string | undefined => sessionRoot ?? (config.root.trim().length > 0 ? config.root.trim() : undefined)

  /**
   * Resolve one path a caller named, against the session directory.
   * @param value - the path.
   * @param base - the session directory, when there is one.
   * @returns the absolute path.
   */
  const resolvePath = async (value: string, base: string | undefined): Promise<string> => {
    if (isAbsolute(value)) return resolve(value)
    return resolve(base ?? process.cwd(), value)
  }

  /**
   * Resolve what a call named as its repository: a path, or a repository name.
   * @param named - what the call wrote.
   * @param base - the session directory, when there is one.
   * @returns the repository identity.
   * @throws {Error} when nothing answers to that name.
   */
  const resolveNamed = async (named: string, base: string | undefined): Promise<RepoIdentity> => {
    const resolved = await resolvePath(named, base)
    let pathRefusal: string | undefined
    if (await directoryExists(resolved)) {
      const identity = await runQuietly(() => identifyRepo(git, resolved))
      if (identity !== undefined) return identity
      // It is a real directory, just not a checkout. Saying so is what a caller
      // who mistyped a path needs; the name lookup below may still succeed.
      pathRefusal = `"${named}" is not inside a git repository${resolved === named ? '' : ` (${resolved})`}`
    }
    // Not a path: a repository name, looked for under every root a panel would
    // offer. The scan lists no statuses, so it is one walk and no git commands.
    const seen: string[] = []
    for (const root of await rootsPayload().then(payload => payload.roots.map(entry => entry.path))) {
      seen.push(root)
      const scan = await discoverRepos(root, { maxDepth, maxRepos })
      const match = scan.paths.find(path => path.split(/[\\/]/u).pop() === named)
      if (match !== undefined) return await identifyRepo(git, match)
    }
    if (pathRefusal !== undefined) throw new Error(pathRefusal)
    throw new Error(`"${named}" is neither a directory nor the name of a repository under ${seen.length === 0 ? 'any known root' : seen.join(', ')}`)
  }

  /** The roots a panel may browse, the configured one first. */
  const rootsPayload = async (): Promise<RootsPayload> => {
    const roots: RepoRoot[] = []
    const add = (path: string, title: string, source: RepoRoot['source']): void => {
      const trimmed = path.trim()
      if (trimmed.length === 0) return
      // One spelling for one directory: git prints forward slashes, Windows hands
      // back backslashes, and a configured root may be either.
      const resolved = resolve(trimmed)
      if (roots.some(entry => entry.path.toLowerCase() === resolved.toLowerCase())) return
      roots.push({ path: resolved, title, source })
    }
    const configured = config.root.trim()
    if (configured.length > 0) add(configured, configured.split(/[\\/]/u).filter(Boolean).pop() ?? configured, 'config')
    const registry = workspaceRegistry()
    if (registry !== undefined) {
      for (const record of runQuietlySync(() => registry.list()) ?? []) {
        const path = typeof record.path === 'string' ? record.path : undefined
        if (path === undefined || path.length === 0) continue
        const title = typeof record.title === 'string' && record.title.length > 0
          ? record.title
          : path.split(/[\\/]/u).filter(Boolean).pop() ?? path
        add(path, title, 'workspace')
      }
    }
    if (sessionRoot !== undefined && sessionRoot.length > 0) {
      add(sessionRoot, sessionRoot.split(/[\\/]/u).filter(Boolean).pop() ?? sessionRoot, 'session')
    }
    return { roots, default: roots[0]?.path ?? '', capabilities }
  }

  /** The root a discovery call scans when it names none. */
  const defaultRoot = async (base: string | undefined): Promise<string> => {
    if (base !== undefined && base.length > 0) return base
    const roots = await rootsPayload()
    if (roots.default.length > 0) return roots.default
    throw new Error('no repository root is known: pass root, or configure one with the plugin\'s root setting')
  }

  applyGitTools(ctx, {
    git,
    identify: async (directory, signal) => await identifyRepo(git, directory, signal),
    resolveNamed,
    resolvePath,
    summary: async (repo, signal) => await summarizeRepo(git, repo.worktree, signal),
    sessionDirectory: directoryOf,
    discoveryRoot: async (call) => await defaultRoot(await directoryOf(call)),
    discoveryDepth: maxDepth,
    discoveryLimit: maxRepos,
    maxPatchBytes,
    logLimit,
    maxFiles,
    allowStage,
    allowCommit,
    allowSwitch,
  })

  // The browser carrier is optional: a headless deployment has no panel, and
  // every tool works without it.
  ctx.inject(['connection'], (webCtx) => {
    const connection = optionalService<ConnectionHandle>(webCtx, 'connection')
    if (connection === undefined) return
    const serve = (path: string, method: 'GET' | 'POST', handler: (request: Request) => Promise<unknown>): void => {
      webCtx.effect(() => connection.fetch.register({
        path,
        methods: [method],
        requestBody: 'buffered',
        fetch: async (request: Request): Promise<Response> => {
          let body: unknown
          try {
            body = await handler(request)
          } catch (error: unknown) {
            body = { message: error instanceof Error ? error.message : String(error) }
          }
          return Response.json(body, { headers: { 'cache-control': 'no-store' } })
        },
      }), `dsh-git: ${method} ${path}`)
    }

    serve(GIT_ROOTS_PATH, 'GET', async () => await rootsPayload())

    serve(GIT_REPOS_PATH, 'GET', async (request): Promise<ReposPayload> => {
      const named = new URL(request.url).searchParams.get('root') ?? ''
      const root = named.trim().length > 0
        ? await resolvePath(named.trim(), routeBase() ?? process.cwd())
        : await defaultRoot(routeBase())
      const listed = await listRepos(git, root, { maxDepth, maxRepos, maxFiles: 0, signal: request.signal })
      return { root: listed.root, repos: listed.repos, truncated: listed.truncated, ...listed.failures.length === 0 ? {} : { message: listed.failures.join('; ') } }
    })

    serve(GIT_STATUS_PATH, 'GET', async (request): Promise<StatusPayload> => {
      const query = new URL(request.url).searchParams
      const repo = await resolveNamed(query.get('repo') ?? '', routeBase())
      return { status: await readStatus(git, repo, { maxFiles, signal: request.signal }) }
    })

    serve(GIT_DIFF_PATH, 'GET', async (request): Promise<DiffAnswer> => {
      const query = new URL(request.url).searchParams
      const repo = await resolveNamed(query.get('repo') ?? '', routeBase())
      const scope = (query.get('scope') ?? 'working') as DiffScope
      const path = query.get('path') ?? ''
      return {
        diff: await readDiff(git, repo, {
          scope,
          ...query.get('ref') === null ? {} : { ref: query.get('ref') ?? '' },
          ...path.length === 0 ? {} : { paths: [path] },
          maxBytes: maxPatchBytes,
          signal: request.signal,
        }),
      }
    })

    // The history the graph draws: every ref, parents before children, bounded —
    // the panel asks again with a larger limit when the reader wants more.
    serve(GIT_LOG_PATH, 'GET', async (request): Promise<LogPayload> => {
      const query = new URL(request.url).searchParams
      const repo = await resolveNamed(query.get('repo') ?? '', routeBase())
      const limit = quantity(query.get('limit'), logLimit, 1, 200)
      const commits = await readLog(git, repo, { limit, all: true, topo: true, signal: request.signal })
      return { repo: await summarizeRepo(git, repo.worktree, request.signal), commits }
    })

    // The panel's commit is the tool's commit — same message handling, same
    // hooks, same refusal — with one addition: asking to commit everything first
    // stages everything, untracked files included, because that is what the box
    // says it does.
    serve(GIT_COMMIT_PATH, 'POST', async (request): Promise<CommitAnswer> => {
      if (!allowCommit) return { message: 'committing is disabled in this deployment' }
      const body = await request.json().catch(() => ({})) as Partial<CommitRequest>
      if (typeof body.repo !== 'string' || typeof body.message !== 'string') {
        return { message: 'the request names no repository or no message' }
      }
      const repo = await resolveNamed(body.repo, routeBase())
      if (body.all === true) {
        await applyStage(git, repo, { mode: 'stage', all: true, signal: request.signal })
      }
      const committed = await createCommit(git, repo, { message: body.message, signal: request.signal })
      return {
        status: await readStatus(git, repo, { maxFiles, signal: request.signal }),
        commit: committed.commit,
        files: committed.files,
      }
    })

    // The panel's stage and unstage go through the same guarded function the
    // `git_stage` tool uses; a deployment that disabled staging answers with the
    // refusal rather than registering a second, unguarded path.
    serve(GIT_STAGE_PATH, 'POST', async (request): Promise<StageAnswer> => {
      if (!allowStage) return { message: 'staging is disabled in this deployment' }
      const body = await request.json().catch(() => ({})) as Partial<StageRequest>
      if (typeof body.repo !== 'string') return { message: 'the request names no repository' }
      const mode = body.mode
      if (mode !== 'stage' && mode !== 'unstage' && mode !== 'discard') {
        return { message: `unknown mode "${String(mode)}": use stage, unstage, or discard` }
      }
      const repo = await resolveNamed(body.repo, routeBase())
      const status = await applyStage(git, repo, {
        mode,
        ...Array.isArray(body.paths) ? { paths: body.paths.filter(path => typeof path === 'string') } : {},
        ...body.all === true ? { all: true } : {},
        signal: request.signal,
      })
      return { status }
    })
  })
}

/**
 * One bounded quantity a request named.
 * @param raw - the query parameter, possibly absent or not a number.
 * @param fallback - the value to use when it is absent.
 * @param min - the smallest allowed value.
 * @param max - the largest allowed value.
 * @returns the value, inside the bounds.
 */
function quantity(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** Run one async probe, answering undefined rather than throwing. */
async function runQuietly<T>(probe: () => Promise<T>): Promise<T | undefined> {
  try {
    return await probe()
  } catch {
    return undefined
  }
}

/** Run one synchronous probe, answering undefined rather than throwing. */
function runQuietlySync<T>(probe: () => T): T | undefined {
  try {
    return probe()
  } catch {
    return undefined
  }
}

export { Git, applyGitTools, directoryExists, identifyRepo }
export type { RepoIdentity }
