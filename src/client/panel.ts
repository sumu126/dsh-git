/**
 * The state one Git panel reads and the gestures it performs.
 *
 * It talks to this plugin's own authenticated routes — the same functions the
 * tools call — so the panel and a tool call can never report two different
 * branches, and it aborts a read the moment a newer one starts, so a slow root
 * cannot land on top of a newer selection.
 *
 * The store is a plain snapshot with the shell's `SnapshotStore` shape: the
 * renderer turns it into the `useGitPanel` selector hook, and the Node check can
 * drive it without a DOM.
 *
 * @module dsh-git/src/client/panel
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  GIT_COMMIT_PATH, GIT_DIFF_PATH, GIT_LOG_PATH, GIT_REPOS_PATH, GIT_ROOTS_PATH, GIT_STAGE_PATH, GIT_STATUS_PATH,
  type Capabilities, type CommitAnswer, type CommitSummary, type DiffAnswer, type DiffPayload, type LogPayload,
  type RepoRoot, type ReposPayload, type RepoStatus, type RepoSummary, type RootsPayload, type StageAnswer,
  type StatusPayload,
} from '../contract.ts'

/** The comparison the panel's diff section shows. */
export type PanelScope = 'working' | 'staged'

/** What went wrong, and whether the host is simply older than the page. */
export interface PanelFailure {
  /** `stale` is a route this process never registered: the page outlived a build. */
  kind: 'stale' | 'other'
  /** The sentence to show, or the raw reason for `other`. */
  message: string
}

/** The selected repository's detail, as the panel draws it. */
export interface PanelDetail {
  /** The repository's status, once it arrived. */
  status: RepoStatus | null
  /** The diff for the selected scope, once it arrived. */
  diff: DiffPayload | null
  /** Why the detail could not be read, when it could not. */
  message: string | null
  /** True while a read is in flight. */
  loading: boolean
}

/** Everything the panel draws from. */
export interface GitPanelSnapshot {
  /** Where the repository list's read stands. */
  phase: 'idle' | 'loading' | 'ready' | 'failed'
  /** Roots the panel may browse. */
  roots: RepoRoot[]
  /** The selected root. */
  root: string
  /** What this deployment lets the panel do. */
  capabilities: Capabilities
  /** Repositories found under the root. */
  repos: RepoSummary[]
  /** True when the root's scan stopped at the repository bound. */
  truncated: boolean
  /** The selected repository path, when one is chosen. */
  selected: string | null
  /** True when the repository list is folded to the selection. */
  reposCollapsed: boolean
  /** The selected repository's detail. */
  detail: PanelDetail | null
  /** The comparison the diff section shows. */
  scope: PanelScope
  /** Why the repository list is empty, when that is a refusal. */
  message: string | null
  /** Every recent commit across every ref, newest first, for the graph. */
  commits: CommitSummary[]
  /** How many commits the graph may show; "load more" raises it. */
  graphLimit: number
  /** Why the history could not be read, when it could not. */
  graphFailure: PanelFailure | null
  /** The commit message draft. */
  draft: string
  /** Which mutation is in flight, if any. */
  busy: 'commit' | 'stage' | null
  /** Why the last mutation failed, if it did. */
  actionFailure: PanelFailure | null
  /** The commit whose changes are open under the graph. */
  selectedCommit: string | null
  /** That commit's read: its changed paths, and the whole patch. */
  commitDiff: DiffPayload | null
  /** The changed path of that commit currently shown. */
  commitFile: string | null
  /** That path's patch, once it arrived. */
  commitFileDiff: DiffPayload | null
  /** True while a changed path's patch is in flight. */
  commitFileLoading: boolean
  /** True while the open commit's own read is in flight. */
  commitLoading: boolean
}

/** The gestures the panel offers. */
export interface GitPanelActions {
  /** Re-read the roots, the repositories, and the selection. */
  refresh: () => void
  /** Browse another root. */
  chooseRoot: (path: string) => void
  /** Show another repository. */
  select: (repoPath: string) => void
  /** Fold the repository list to the selection, or unfold it. */
  toggleRepos: () => void
  /** Show another comparison. */
  chooseScope: (scope: PanelScope) => void
  /** Write the commit message draft. */
  writeDraft: (text: string) => void
  /** Commit the staged changes; `all` stages every change first. */
  commit: (all: boolean) => void
  /** Stage one path. */
  stage: (path: string) => void
  /** Unstage one path. */
  unstage: (path: string) => void
  /** Stage every change. */
  stageAll: () => void
  /** Unstage everything. */
  unstageAll: () => void
  /** Open one commit's changes under the graph. */
  openCommit: (hash: string) => void
  /** Show one changed path of that commit. */
  openCommitFile: (path: string) => void
  /** Close the open commit. */
  closeCommit: () => void
  /** Raise the number of commits the graph reads. */
  loadMore: () => void
}

/** The commit limit the graph opens on, and how far "load more" takes it. */
const GRAPH_STEP = 50

/** The most commits the graph will ever read in one request. */
const GRAPH_MAX = 200

/** The sentinel the view turns into "write a message first". */
export const COMMIT_NEEDS_MESSAGE = 'commit-needs-message'

/** The message one thrown value carries. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Classify one failed read or write. */
function failureOf(error: unknown): PanelFailure {
  const message = messageOf(error)
  return { kind: /^HTTP 404$/u.test(message) ? 'stale' : 'other', message }
}

/**
 * Read one JSON answer from this plugin's own route.
 * @param path - the route.
 * @param query - parameters to send; an empty value is left out.
 * @param signal - cancellation, so a superseded read stops waiting.
 * @returns the decoded body.
 * @throws {Error} when the route answered a non-success status.
 */
async function readJson<T>(path: string, query: Record<string, string>, signal: AbortSignal): Promise<T> {
  const url = new URL(path, window.location.origin)
  for (const [key, value] of Object.entries(query)) {
    if (value.length > 0) url.searchParams.set(key, value)
  }
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json() as T
}

/**
 * Post one JSON body to this plugin's own route.
 * @param path - the route.
 * @param body - the JSON body.
 * @param signal - cancellation.
 * @returns the decoded answer.
 * @throws {Error} when the route answered a non-success status.
 */
async function sendJson<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, window.location.origin), {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json() as T
}

/** The panel's readable, refreshable state. */
export class GitPanelController implements SnapshotStore<GitPanelSnapshot> {
  private state: GitPanelSnapshot = {
    phase: 'idle',
    roots: [],
    root: '',
    capabilities: { stage: false, commit: false, switch: false },
    repos: [],
    truncated: false,
    selected: null,
    reposCollapsed: false,
    detail: null,
    scope: 'working',
    message: null,
    commits: [],
    graphLimit: GRAPH_STEP,
    graphFailure: null,
    draft: '',
    busy: null,
    actionFailure: null,
    selectedCommit: null,
    commitDiff: null,
    commitFile: null,
    commitFileDiff: null,
    commitFileLoading: false,
    commitLoading: false,
  }

  private readonly listeners = new Set<() => void>()

  /** The navigation currently in flight; a newer one aborts it. */
  private abort: AbortController | null = null

  /** The mutation currently in flight; navigation does not abort it. */
  private action: AbortController | null = null

  private disposed = false

  /** The user-facing gestures this controller offers. */
  readonly actions: GitPanelActions = {
    // A refresh re-reads the roots too: a workspace registered since the panel
    // opened should appear without reopening it.
    refresh: () => { void this.navigate({ roots: true }) },
    chooseRoot: (path) => {
      this.set({
        ...this.state, root: path, selected: null, detail: null, message: null,
        commits: [], selectedCommit: null, commitDiff: null, commitFile: null, commitFileDiff: null,
      })
      void this.navigate()
    },
    select: (repoPath) => {
      this.set({
        ...this.state, selected: repoPath, detail: null,
        selectedCommit: null, commitDiff: null, commitFile: null, commitFileDiff: null,
      })
      void this.navigate()
    },
    toggleRepos: () => {
      this.set({ ...this.state, reposCollapsed: !this.state.reposCollapsed })
    },
    chooseScope: (scope) => {
      this.set({ ...this.state, scope })
      void this.navigate()
    },
    writeDraft: (text) => {
      this.set({ ...this.state, draft: text, actionFailure: null })
    },
    commit: (all) => { void this.commitMessage(all) },
    stage: (path) => { void this.mutateStage('stage', [path]) },
    unstage: (path) => { void this.mutateStage('unstage', [path]) },
    stageAll: () => { void this.mutateStage('stage', undefined, true) },
    unstageAll: () => { void this.mutateStage('unstage', undefined, true) },
    openCommit: (hash) => { void this.openCommitChanges(hash) },
    openCommitFile: (path) => { void this.openCommitFile(path) },
    closeCommit: () => {
      this.set({
        ...this.state, selectedCommit: null, commitDiff: null, commitFile: null,
        commitFileDiff: null, commitFileLoading: false, commitLoading: false,
      })
    },
    loadMore: () => {
      const limit = Math.min(GRAPH_MAX, this.state.graphLimit + GRAPH_STEP)
      if (limit === this.state.graphLimit) return
      this.set({ ...this.state, graphLimit: limit })
      void this.navigate()
    },
  }

  /**
   * Read the current snapshot.
   * @returns the state, as the last read left it.
   */
  getSnapshot(): GitPanelSnapshot {
    return this.state
  }

  /**
   * Subscribe to a new snapshot.
   * @param listener - called after every change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Replace the snapshot wholesale.
   * @param next - the state to publish.
   */
  set(next: GitPanelSnapshot): void {
    if (this.disposed) return
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Change the snapshot through a draft, as the shell's store contract expects.
   * @param mutator - edits one copy of the state in place.
   */
  update(mutator: (draft: GitPanelSnapshot) => void): void {
    const draft = structuredClone(this.state)
    mutator(draft)
    this.set(draft)
  }

  /** Start, or restart, the panel's reads. Calling it again refreshes. */
  start(): void {
    if (this.disposed) return
    void this.navigate({ roots: this.state.roots.length === 0 })
  }

  /** End the pending read and release every listener. */
  dispose(): void {
    this.disposed = true
    this.abort?.abort()
    this.action?.abort()
    this.abort = null
    this.action = null
    this.listeners.clear()
  }

  /**
   * Run one navigation: roots, then repositories, then the selection's detail
   * and the history.
   * @param options - whether the root list itself has to be re-read.
   */
  private async navigate(options: { roots?: boolean } = {}): Promise<void> {
    if (this.disposed) return
    this.abort?.abort()
    const controller = new AbortController()
    this.abort = controller
    this.set({ ...this.state, phase: this.state.phase === 'ready' ? 'ready' : 'loading', message: null })
    try {
      if (options.roots === true || this.state.roots.length === 0) await this.loadRoots(controller.signal)
      await this.loadRepos(controller.signal)
      if (this.state.selected !== null) {
        await Promise.all([
          this.loadDetail(controller.signal),
          this.loadLog(controller.signal),
        ])
      }
      if (this.disposed || controller.signal.aborted) return
      this.set({ ...this.state, phase: 'ready' })
    } catch (error: unknown) {
      // A read the panel itself superseded is not a failure to report.
      if (!controller.signal.aborted && !this.disposed) {
        this.set({ ...this.state, phase: 'failed', message: messageOf(error) })
      }
    } finally {
      if (this.abort === controller) this.abort = null
    }
  }

  /** Read the roots a panel may browse, and what the host allows. */
  private async loadRoots(signal: AbortSignal): Promise<void> {
    const payload = await readJson<RootsPayload>(GIT_ROOTS_PATH, {}, signal)
    if (this.disposed) return
    const root = this.state.root.length > 0 ? this.state.root : payload.default
    // A host from before the capabilities field answers without it. Reading that
    // as "nothing is allowed" is what keeps a page that hot-swapped against an
    // older process showing a panel instead of a stack trace — and it is true:
    // that process has no commit or stage route to call.
    this.set({
      ...this.state,
      roots: payload.roots,
      root,
      capabilities: payload.capabilities ?? { stage: false, commit: false, switch: false },
    })
  }

  /** Read the repositories under the selected root. */
  private async loadRepos(signal: AbortSignal): Promise<void> {
    if (this.state.root.length === 0) {
      this.set({ ...this.state, repos: [], truncated: false, selected: null, detail: null, commits: [] })
      return
    }
    const payload = await readJson<ReposPayload>(GIT_REPOS_PATH, { root: this.state.root }, signal)
    if (this.disposed) return
    const keep = payload.repos.some(repo => repo.path === this.state.selected)
    const selected = keep ? this.state.selected : payload.repos[0]?.path ?? null
    this.set({
      ...this.state,
      repos: payload.repos,
      truncated: payload.truncated,
      selected,
      detail: this.state.selected === selected ? this.state.detail : null,
      ...payload.message === undefined ? {} : { message: payload.message },
    })
  }

  /** Read the selected repository's status and the diff on screen. */
  private async loadDetail(signal: AbortSignal): Promise<void> {
    const repo = this.state.selected
    if (repo === null) {
      this.set({ ...this.state, detail: null })
      return
    }
    this.set({ ...this.state, detail: { status: null, diff: null, message: null, loading: true } })
    const [statusAnswer, diffAnswer] = await Promise.all([
      readJson<StatusPayload>(GIT_STATUS_PATH, { repo }, signal),
      readJson<DiffAnswer>(GIT_DIFF_PATH, { repo, scope: this.state.scope }, signal),
    ])
    if (this.disposed) return
    this.set({
      ...this.state,
      detail: {
        status: statusAnswer.status ?? null,
        diff: diffAnswer.diff ?? null,
        message: statusAnswer.message ?? diffAnswer.message ?? null,
        loading: false,
      },
    })
  }

  /** Read the history the graph draws. */
  private async loadLog(signal: AbortSignal): Promise<void> {
    const repo = this.state.selected
    if (repo === null) {
      this.set({ ...this.state, commits: [], graphFailure: null })
      return
    }
    try {
      const payload = await readJson<LogPayload>(GIT_LOG_PATH, { repo, limit: String(this.state.graphLimit) }, signal)
      if (this.disposed) return
      this.set({
        ...this.state,
        commits: payload.commits,
        graphFailure: payload.message === undefined ? null : { kind: 'other', message: payload.message },
      })
    } catch (error: unknown) {
      if (this.disposed || signal.aborted) return
      // A route this process never registered is a host older than the page, and
      // the reader is told the one thing that fixes it.
      this.set({ ...this.state, commits: [], graphFailure: failureOf(error) })
    }
  }

  /**
   * Run one mutation, then re-read what it changed.
   *
   * A click is worth a handful of local git commands: the statuses, the diff on
   * screen, and the graph all belong to the same truth, so one read after the
   * write is cheaper than a panel that shows a stale half.
   * @param kind - which mutation this is.
   * @param work - performs the request.
   * @param after - applies what the answer already says, before the re-read.
   */
  private async mutate<T>(
    kind: 'commit' | 'stage',
    work: (signal: AbortSignal) => Promise<T>,
    after?: (value: T) => void,
  ): Promise<void> {
    if (this.disposed || this.state.busy !== null) return
    this.abort?.abort()
    const controller = new AbortController()
    this.action = controller
    this.set({ ...this.state, busy: kind, actionFailure: null })
    try {
      const value = await work(controller.signal)
      if (this.disposed) return
      after?.(value)
      await this.navigate()
    } catch (error: unknown) {
      if (this.disposed) return
      this.set({ ...this.state, actionFailure: failureOf(error) })
    } finally {
      if (this.action === controller) this.action = null
      if (!this.disposed) this.set({ ...this.state, busy: null })
    }
  }

  /** Commit the staged changes, or everything. */
  private async commitMessage(all: boolean): Promise<void> {
    const repo = this.state.selected
    if (repo === null) return
    const message = this.state.draft.trim()
    if (message.length === 0) {
      this.set({ ...this.state, actionFailure: { kind: 'other', message: COMMIT_NEEDS_MESSAGE } })
      return
    }
    await this.mutate('commit', async signal => await sendJson<CommitAnswer>(GIT_COMMIT_PATH, {
      repo, message, ...all ? { all: true } : {},
    }, signal), (answer) => {
      if (answer.message !== undefined) throw new Error(answer.message)
      this.set({ ...this.state, draft: '', selectedCommit: null, commitDiff: null })
    })
  }

  /** Stage or unstage one path, or everything. */
  private async mutateStage(mode: 'stage' | 'unstage', paths: string[] | undefined, all = false): Promise<void> {
    const repo = this.state.selected
    if (repo === null) return
    await this.mutate('stage', async signal => await sendJson<StageAnswer>(GIT_STAGE_PATH, {
      repo, mode, ...paths === undefined ? {} : { paths }, ...all ? { all: true } : {},
    }, signal), (answer) => {
      if (answer.message !== undefined) throw new Error(answer.message)
    })
  }

  /**
   * Read one commit: its changed paths first, then the patch of the first one.
   *
   * A commit is read the way a log view is read — the list of files it touched,
   * then one file's diff — because that is what a reader wants to see: what
   * changed, and then how.
   */
  private async openCommitChanges(hash: string): Promise<void> {
    const repo = this.state.selected
    if (repo === null || this.disposed) return
    if (this.state.selectedCommit === hash) {
      this.actions.closeCommit()
      return
    }
    this.set({
      ...this.state, selectedCommit: hash, commitDiff: null, commitFile: null,
      commitFileDiff: null, commitFileLoading: false, commitLoading: true, actionFailure: null,
    })
    try {
      const answer = await readJson<DiffAnswer>(GIT_DIFF_PATH, { repo, scope: 'commit', ref: hash }, new AbortController().signal)
      if (this.disposed) return
      const diff = answer.diff ?? null
      this.set({ ...this.state, commitDiff: diff, commitLoading: false })
      const first = diff?.files[0]
      // The first changed path opens on arrival, so a click already shows a diff
      // rather than an empty box and a list to click again.
      if (first !== undefined) await this.openCommitFile(first.path)
    } catch (error: unknown) {
      if (this.disposed) return
      this.set({ ...this.state, commitLoading: false, actionFailure: failureOf(error) })
    }
  }

  /**
   * Read one changed path of the open commit.
   *
   * The route already narrows a commit diff with a path, so this is the same
   * read as the commit's own, one file wide.
   */
  private async openCommitFile(path: string): Promise<void> {
    const repo = this.state.selected
    const hash = this.state.selectedCommit
    if (repo === null || hash === null || this.disposed) return
    if (this.state.commitFile === path && this.state.commitFileDiff !== null) return
    this.set({ ...this.state, commitFile: path, commitFileDiff: null, commitFileLoading: true })
    try {
      const answer = await readJson<DiffAnswer>(
        GIT_DIFF_PATH,
        { repo, scope: 'commit', ref: hash, path },
        new AbortController().signal,
      )
      if (this.disposed) return
      this.set({ ...this.state, commitFileDiff: answer.diff ?? null, commitFileLoading: false })
    } catch (error: unknown) {
      if (this.disposed) return
      this.set({ ...this.state, commitFileLoading: false, actionFailure: failureOf(error) })
    }
  }
}
