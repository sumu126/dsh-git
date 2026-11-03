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
  GIT_DIFF_PATH, GIT_REPOS_PATH, GIT_ROOTS_PATH, GIT_STATUS_PATH,
  type DiffAnswer, type DiffPayload, type RepoRoot, type ReposPayload, type RepoStatus,
  type RepoSummary, type RootsPayload, type StatusPayload,
} from '../contract.ts'

/** The comparison the panel's diff section shows. */
export type PanelScope = 'working' | 'staged'

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
  /** Repositories found under the root. */
  repos: RepoSummary[]
  /** True when the root's scan stopped at the repository bound. */
  truncated: boolean
  /** The selected repository path, when one is chosen. */
  selected: string | null
  /** The selected repository's detail. */
  detail: PanelDetail | null
  /** The comparison the diff section shows. */
  scope: PanelScope
  /** Why the repository list is empty, when that is a refusal. */
  message: string | null
}

/** The gestures the panel offers. */
export interface GitPanelActions {
  /** Re-read the roots, the repositories, and the selection. */
  refresh: () => void
  /** Browse another root. */
  chooseRoot: (path: string) => void
  /** Show another repository. */
  select: (repoPath: string) => void
  /** Show another comparison. */
  chooseScope: (scope: PanelScope) => void
}

/** The message one thrown value carries. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** The panel's readable, refreshable state. */
export class GitPanelController implements SnapshotStore<GitPanelSnapshot> {
  private state: GitPanelSnapshot = {
    phase: 'idle', roots: [], root: '', repos: [], truncated: false,
    selected: null, detail: null, scope: 'working', message: null,
  }

  private readonly listeners = new Set<() => void>()

  private abort: AbortController | null = null

  private disposed = false

  /** The user-facing gestures this controller offers. */
  readonly actions: GitPanelActions = {
    // A refresh re-reads the roots too: a workspace registered since the panel
    // opened should appear without reopening it.
    refresh: () => { void this.navigate({ roots: true }) },
    chooseRoot: (path) => {
      this.set({ ...this.state, root: path, selected: null, detail: null, message: null })
      void this.navigate()
    },
    select: (repoPath) => {
      this.set({ ...this.state, selected: repoPath, detail: null })
      void this.navigate()
    },
    chooseScope: (scope) => {
      this.set({ ...this.state, scope })
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
    this.abort = null
    this.listeners.clear()
  }

  /**
   * Run one navigation: roots, then repositories, then the selection's detail.
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
      if (this.state.selected !== null) await this.loadDetail(controller.signal)
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

  /** Read the roots a panel may browse. */
  private async loadRoots(signal: AbortSignal): Promise<void> {
    const payload = await readJson<RootsPayload>(GIT_ROOTS_PATH, {}, signal)
    if (this.disposed) return
    const root = this.state.root.length > 0 ? this.state.root : payload.default
    this.set({ ...this.state, roots: payload.roots, root })
  }

  /** Read the repositories under the selected root. */
  private async loadRepos(signal: AbortSignal): Promise<void> {
    if (this.state.root.length === 0) {
      this.set({ ...this.state, repos: [], truncated: false, selected: null, detail: null })
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

  /** Read the selected repository's status and diff. */
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
}
