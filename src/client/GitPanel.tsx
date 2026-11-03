/**
 * The right-sidebar Git panel: a source-control page for one repository.
 *
 * Reading from the top: the root and the repository, the commit box, the changes
 * with their per-file stage actions, the diff of the comparison on screen, and
 * the commit graph — every commit, drawn with its lane, so the history is a
 * picture rather than a list. Clicking a commit opens the patch it introduced.
 *
 * Mutations go through the same host functions the tools use, and only when the
 * deployment's switches allow them; a deployment that turned committing off is
 * never shown a commit box.
 *
 * @module dsh-git/src/client/GitPanel
 */

import { useState, type KeyboardEvent, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Capabilities, CommitSummary, DiffPayload, RepoStatus, RepoSummary } from '../contract.ts'
import { COMMIT_NEEDS_MESSAGE, type GitPanelActions, type GitPanelSnapshot } from './panel.ts'
import { GRAPH_COLORS, edgePath, layoutGraph } from './graph.ts'
import styles from './panel.module.css'

/** What the tab body's slot entry injects. */
export interface GitPanelFace {
  hooks: {
    /** The panel's snapshot, bound by the renderer as `useGitPanel`. */
    gitPanel: SnapshotStore<GitPanelSnapshot>
  }
  /** The panel's gestures. */
  git: GitPanelActions
}

/** Props the renderer binds for this right-sidebar tab. */
export type GitPanelProps =
  PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'panel.git'>
  & InjectFace<GitPanelFace>

/**
 * The guide card's glyph for this tab type.
 *
 * Drawn here rather than borrowed from the shell: the shell renamed its whole
 * icon set between generations, and a missing export renders as nothing at all.
 * @param props - the square edge the guide asks for.
 * @returns the glyph.
 */
export function GitIcon({ size }: { size?: number | undefined }): ReactNode {
  const edge = size ?? 16
  return (
    <svg width={edge} height={edge} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="8" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.25v5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4 8h3.2a2.8 2.8 0 0 0 2.8-2.8V6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4 8h4.2a2.8 2.8 0 0 1 2.8 2.8v.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * The panel chip's title.
 *
 * Registered rather than left to the type definition, because the chip otherwise
 * keeps the title the registry captured when the tab opened, and a language
 * switch would leave it behind.
 * @param props - the slot's locale seat.
 * @returns the page's name in the active language.
 */
export function GitPanelTitle({ t }: PropsLocale<'panel.git'>): ReactNode {
  return t('panelTitle')
}

/** What a snapshot from a host that predates the capabilities field means. */
const NO_CAPABILITIES: Capabilities = { stage: false, commit: false, switch: false }

/** A summary's position relative to its upstream, in the reader's language. */
function position(t: GitPanelProps['t'], repo: RepoSummary): string {
  if (repo.detached) return t('detached')
  const parts: string[] = []
  if (repo.ahead > 0) parts.push(t('ahead', { count: String(repo.ahead) }))
  if (repo.behind > 0) parts.push(t('behind', { count: String(repo.behind) }))
  return parts.length === 0 ? '' : parts.join(' · ')
}

/** The change counts, as one line. */
function counts(t: GitPanelProps['t'], repo: RepoSummary): string {
  const parts: string[] = []
  if (repo.staged > 0) parts.push(`${String(repo.staged)} ${t('staged')}`)
  if (repo.unstaged > 0) parts.push(`${String(repo.unstaged)} ${t('unstaged')}`)
  if (repo.untracked > 0) parts.push(`${String(repo.untracked)} ${t('untracked')}`)
  if (repo.conflicted > 0) parts.push(`${String(repo.conflicted)} ${t('conflicted')}`)
  return parts.length === 0 ? t('clean') : parts.join(' · ')
}

/** One entry of the repository list. */
function RepoRow(
  { t, repo, selected, onSelect }: { t: GitPanelProps['t'], repo: RepoSummary, selected: boolean, onSelect: () => void },
): ReactNode {
  const where = position(t, repo)
  return (
    <button
      type="button"
      className={selected ? `${styles.repo} ${styles.repoActive}` : styles.repo}
      onClick={onSelect}
      title={repo.path}
    >
      <span className={styles.repoName}>{repo.name}</span>
      <span className={styles.repoMeta}>
        <span className={styles.branch}>{repo.detached ? t('detached') : repo.branch ?? '—'}</span>
        {where.length === 0 ? null : <span className={styles.position}>{where}</span>}
      </span>
      <span className={repo.dirty ? `${styles.counts} ${styles.dirty}` : styles.counts}>{counts(t, repo)}</span>
    </button>
  )
}

/** The section header every part of the page shares. */
function SectionHead(
  { title, meta, children }: { title: string, meta?: ReactNode, children?: ReactNode },
): ReactNode {
  return (
    <header className={styles.sectionHead}>
      <span className={styles.sectionTitle}>{title}</span>
      {children}
      {meta === undefined ? null : <span className={styles.sectionMeta}>{meta}</span>}
    </header>
  )
}

/** The banner a refused or stale action shows. */
function Failure(
  { t, failure }: { t: GitPanelProps['t'], failure: NonNullable<GitPanelSnapshot['actionFailure']> },
): ReactNode {
  if (failure.message === COMMIT_NEEDS_MESSAGE) {
    return <p className={styles.failure} role="status">{t('commitNeedsMessage')}</p>
  }
  return (
    <p className={styles.failure} role="status">
      {failure.kind === 'stale' ? t('hostStale') : t('actionFailed', { message: failure.message })}
    </p>
  )
}

/** The commit box: the message, whether to stage everything, and the button. */
function CommitBox(
  { t, state, actions }: { t: GitPanelProps['t'], state: GitPanelSnapshot, actions: GitPanelActions },
): ReactNode {
  // Whether "commit" also stages everything. Local state: it is a preference of
  // the click, not something the repository knows.
  const [stageAll, setStageAll] = useState(false)
  const available = state.capabilities ?? NO_CAPABILITIES
  if (!available.commit) return null
  const busy = state.busy === 'commit'
  const blank = state.draft.trim().length === 0
  const submit = (): void => { actions.commit(stageAll) }
  return (
    <section className={styles.commitBox}>
      <textarea
        className={styles.message}
        rows={2}
        value={state.draft}
        placeholder={t('commitPlaceholder')}
        aria-label={t('commitPlaceholder')}
        onChange={(event) => { actions.writeDraft(event.target.value) }}
        onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            if (!blank && !busy) submit()
          }
        }}
      />
      <div className={styles.commitRow}>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={stageAll}
            onChange={(event) => { setStageAll(event.target.checked) }}
          />
          {t('stageAll')}
        </label>
        <button
          type="button"
          className={styles.primary}
          disabled={blank || busy || state.busy !== null}
          onClick={submit}
        >
          {busy ? t('committing') : t('commitButton')}
        </button>
      </div>
    </section>
  )
}

/** One changed path, with the stage actions that apply to it. */
function ChangeRow(
  { t, file, actions, enabled }: { t: GitPanelProps['t'], file: RepoStatus['files'][number], actions: GitPanelActions, enabled: boolean },
): ReactNode {
  const staged = file.index !== '.' && file.index !== ' '
  const unstaged = file.kind === 'untracked' || (file.worktree !== '.' && file.worktree !== ' ')
  const letters = file.kind === 'untracked' ? '??' : `${file.index}${file.worktree}`
  return (
    <li className={styles.file}>
      <span className={styles.letters} data-kind={file.kind}>{letters}</span>
      <span className={styles.filePath} title={file.path}>{file.path}</span>
      {file.origPath === undefined ? null : <span className={styles.origPath}>← {file.origPath}</span>}
      {enabled
        ? (
          <span className={styles.fileActions}>
            {unstaged
              ? <button type="button" className={styles.iconAction} title={t('stage')} aria-label={t('stage')} onClick={() => { actions.stage(file.path) }}>+</button>
              : null}
            {staged
              ? <button type="button" className={styles.iconAction} title={t('unstage')} aria-label={t('unstage')} onClick={() => { actions.unstage(file.path) }}>−</button>
              : null}
          </span>
        )
        : null}
    </li>
  )
}

/** The changed paths, and the two "all" actions. */
function Changes(
  { t, status, actions, capabilities }: {
    t: GitPanelProps['t']
    status: RepoStatus
    actions: GitPanelActions
    capabilities: GitPanelSnapshot['capabilities']
  },
): ReactNode {
  const stagedCount = status.repo.staged
  return (
    <section className={styles.section}>
      <SectionHead
        title={t('changes')}
        meta={t('files', { count: String(status.files.length) })}
      >
        {capabilities.stage
          ? (
            <span className={styles.sectionActions}>
              <button type="button" className={styles.smallAction} onClick={() => { actions.stageAll() }}>{t('stageAll')}</button>
              <button type="button" className={styles.smallAction} onClick={() => { actions.unstageAll() }}>{t('unstageAll')}</button>
            </span>
          )
          : null}
      </SectionHead>
      {status.files.length === 0
        ? <p className={styles.notice}>{t('clean')}</p>
        : (
          <ul className={styles.files}>
            {status.files.map(file => (
              <ChangeRow
                key={`${file.kind}:${file.path}`}
                t={t}
                file={file}
                actions={actions}
                enabled={capabilities.stage}
              />
            ))}
          </ul>
        )}
      {status.filesTruncated ? <p className={styles.footnote}>{t('filesCut', { count: String(status.files.length) })}</p> : null}
      {capabilities.commit && stagedCount === 0 ? <p className={styles.footnote}>{t('noStaged')}</p> : null}
    </section>
  )
}

/** The diff of the comparison on screen. */
function Compared(
  { t, state, actions }: { t: GitPanelProps['t'], state: GitPanelSnapshot, actions: GitPanelActions },
): ReactNode {
  const diff = state.detail?.diff ?? null
  return (
    <section className={styles.section}>
      <SectionHead
        title={t('diff')}
        meta={diff === null ? undefined : diff.files.length === 0 ? t('noChanges') : `+${String(diff.additions)} −${String(diff.deletions)}`}
      >
        <span className={styles.scopes}>
          <button
            type="button"
            className={state.scope === 'working' ? styles.scopeActive : styles.scope}
            onClick={() => { actions.chooseScope('working') }}
          >
            {t('scopeWorking')}
          </button>
          <button
            type="button"
            className={state.scope === 'staged' ? styles.scopeActive : styles.scope}
            onClick={() => { actions.chooseScope('staged') }}
          >
            {t('scopeStaged')}
          </button>
        </span>
      </SectionHead>
      {diff === null || diff.patch.length === 0
        ? <p className={styles.notice}>{t('noChanges')}</p>
        : <pre className={styles.patch}>{diff.patch}</pre>}
      {diff === null || diff.truncated === false
        ? null
        : <p className={styles.footnote}>{t('patchCut', { bytes: String(new TextEncoder().encode(diff.patch).length) })}</p>}
    </section>
  )
}

/** The lane colours the graph draws with, in the shell's own palette where it has one. */
const LANE_COLORS = [
  '#4c8dff', '#f2a33c', '#43b581', '#c77dff', '#22b8cf', '#ff7a7a', '#a0b3cc', '#d4b106',
] as const

/** One row's height in the graph, and the gutter's lane spacing. */
const ROW_HEIGHT = 46
const LANE_WIDTH = 12
const LANE_PAD = 9

/** The refs a commit carries, as chips: the current branch first. */
function Refs({ refs }: { refs: readonly string[] }): ReactNode {
  if (refs.length === 0) return null
  return (
    <span className={styles.refs}>
      {refs.map((ref) => {
        const current = ref.startsWith('HEAD -> ')
        const local = current ? ref.slice('HEAD -> '.length) : ref
        const tag = local.startsWith('tag: ')
        const label = tag ? local.slice('tag: '.length) : local
        return (
          <span
            key={ref}
            className={tag ? styles.refTag : current ? styles.refHead : styles.ref}
            title={ref}
          >
            {label}
          </span>
        )
      })}
    </span>
  )
}

/** The date a commit row shows, short enough for a narrow column. */
function shortDate(date: string): string {
  // `2026-11-03T11:34:57+08:00` — month, day, and the minute is what a reader
  // scanning a graph wants; the exact second is in `git_show`.
  return date.length >= 16 ? `${date.slice(5, 10)} ${date.slice(11, 16)}` : date
}

/** The graph: every commit, its lane, and the edges that join it to its parents. */
function Graph(
  { t, state, actions }: { t: GitPanelProps['t'], state: GitPanelSnapshot, actions: GitPanelActions },
): ReactNode {
  const layout = layoutGraph(state.commits.map(commit => ({ hash: commit.hash, parents: commit.parents })))
  const lanes = Math.max(1, Math.min(layout.laneCount, 6))
  const gutter = lanes * LANE_WIDTH + LANE_PAD
  const x = (lane: number): number => LANE_PAD / 2 + Math.min(lane, lanes - 1) * LANE_WIDTH + LANE_WIDTH / 2
  const y = (row: number): number => row * ROW_HEIGHT + ROW_HEIGHT / 2
  const open = state.selectedCommit
  const openCommit = state.commits.find(commit => commit.hash === open)
  const total = state.commits.length

  return (
    <section className={styles.section}>
      <SectionHead title={t('graph')} meta={total === 0 ? undefined : String(total)} />
      {state.graphFailure === null
        ? null
        : (
          <p className={styles.failure} role="status">
            {state.graphFailure.kind === 'stale'
              ? t('hostStale')
              : t('graphFailed', { message: state.graphFailure.message })}
          </p>
        )}
      {state.graphFailure === null && total === 0
        ? <p className={styles.notice}>{t('graphEmpty')}</p>
        : null}
      {total === 0
        ? null
        : (
          <div className={styles.graph} style={{ height: `${String(total * ROW_HEIGHT)}px` }}>
            <svg className={styles.graphInk} width={gutter} height={total * ROW_HEIGHT} aria-hidden="true">
              {layout.edges.map(edge => (
                <path
                  key={`${edge.from}-${edge.to}`}
                  d={edgePath(edge, x, y)}
                  fill="none"
                  stroke={LANE_COLORS[edge.color % GRAPH_COLORS] ?? LANE_COLORS[0]}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  opacity={0.85}
                />
              ))}
              {layout.nodes.map(node => (
                <circle
                  key={node.hash}
                  cx={x(node.lane)}
                  cy={y(node.row)}
                  r={node.hash === open ? 4.4 : 3.4}
                  fill={LANE_COLORS[node.color % GRAPH_COLORS] ?? LANE_COLORS[0]}
                  stroke={node.hash === open ? 'currentColor' : 'none'}
                  strokeWidth={1.2}
                />
              ))}
            </svg>
            <ul className={styles.commits} style={{ paddingLeft: `${String(gutter)}px` }}>
              {state.commits.map(commit => (
                <li key={commit.hash} className={styles.commitItem} style={{ height: `${String(ROW_HEIGHT)}px` }}>
                  <button
                    type="button"
                    className={commit.hash === open ? `${styles.commit} ${styles.commitOpen}` : styles.commit}
                    onClick={() => { actions.openCommit(commit.hash) }}
                    title={`${commit.short} ${commit.subject}`}
                  >
                    <span className={styles.commitLine}>
                      <span className={styles.commitSubject}>{commit.subject}</span>
                      <Refs refs={commit.refs} />
                    </span>
                    <span className={styles.commitMeta}>
                      <span>{commit.author}</span>
                      <span className={styles.commitDate}>{shortDate(commit.date)}</span>
                      <span className={styles.commitHash}>{commit.short}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      {total >= state.graphLimit
        ? (
          <div className={styles.more}>
            <button type="button" className={styles.smallAction} onClick={() => { actions.loadMore() }}>{t('loadMore')}</button>
            <span className={styles.footnote}>{t('graphCut', { count: String(state.graphLimit) })}</span>
          </div>
        )
        : null}
      {openCommit === undefined
        ? null
        : (
          <div className={styles.commitDetail}>
            <SectionHead title={t('commitDetail')} meta={`${openCommit.short} · ${openCommit.author}`}>
              <button type="button" className={styles.smallAction} onClick={() => { actions.closeCommit() }}>{t('closeCommit')}</button>
            </SectionHead>
            {state.commitLoading
              ? <p className={styles.notice}>{t('loading')}</p>
              : null}
            {state.commitLoading || state.commitDiff === null ? null : (
              state.commitDiff.files.length === 0
                ? <p className={styles.notice}>{t('noCommitFiles')}</p>
                : (
                  <ul className={styles.files}>
                    {state.commitDiff.files.map(file => (
                      <li key={`${file.status}:${file.path}`}>
                        <button
                          type="button"
                          className={file.path === state.commitFile ? `${styles.commitFile} ${styles.commitFileActive}` : styles.commitFile}
                          onClick={() => { actions.openCommitFile(file.path) }}
                          title={t('showFile', { path: file.path })}
                        >
                          <span className={styles.letters}>{file.status}</span>
                          <span className={styles.filePath}>{file.path}</span>
                          {file.origPath === undefined ? null : <span className={styles.origPath}>← {file.origPath}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )
            )}
            {state.commitFile === null
              ? null
              : state.commitFileLoading
                ? <p className={styles.notice}>{t('loading')}</p>
                : state.commitFileDiff === null || state.commitFileDiff.patch.length === 0
                  ? <p className={styles.notice}>{t('noChanges')}</p>
                  : <pre className={styles.patch}>{state.commitFileDiff.patch}</pre>}
          </div>
        )}
    </section>
  )
}

/**
 * Render the panel.
 * @param props - the panel's state and gestures, and the localized copy.
 * @returns the repository picker, the commit box, the changes, the diff, and the graph.
 */
export function GitPanel(props: GitPanelProps): ReactNode {
  const { t, useGitPanel, git } = props
  const state = useGitPanel(snapshot => snapshot)
  const selected = state.repos.find(repo => repo.path === state.selected)
  const status = state.detail?.status ?? null
  const capabilities = state.capabilities ?? NO_CAPABILITIES

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.label}>{t('root')}</span>
        {state.roots.length > 1
          ? (
            <select
              className={styles.picker}
              value={state.root}
              onChange={(event) => { git.chooseRoot(event.target.value) }}
            >
              {state.roots.map(root => <option key={root.path} value={root.path}>{root.title}</option>)}
            </select>
          )
          : <span className={styles.rootPath} title={state.root}>{state.root.length === 0 ? '—' : state.root}</span>}
        <button
          type="button"
          className={styles.action}
          onClick={() => { git.refresh() }}
          disabled={state.phase === 'loading'}
        >
          {t('refresh')}
        </button>
      </div>

      {state.root.length === 0
        ? <p className={styles.notice} role="status">{t('noRoots')}</p>
        : (
          <>
            {state.phase === 'loading' && state.repos.length === 0
              ? <p className={styles.notice} role="status">{t('loading')}</p>
              : null}
            {state.phase === 'failed'
              ? <p className={styles.failure} role="status">{t('failed', { message: state.message ?? '' })}</p>
              : null}
            {state.phase === 'ready' && state.repos.length === 0
              ? <p className={styles.notice} role="status">{t('noRepos')}</p>
              : null}
            {state.repos.length === 0
              ? null
              : (
                <section className={styles.repoSection}>
                  <SectionHead
                    title={t('repositories')}
                    meta={state.reposCollapsed ? undefined : String(state.repos.length)}
                  >
                    <button
                      type="button"
                      className={styles.smallAction}
                      onClick={() => { git.toggleRepos() }}
                      title={state.reposCollapsed ? t('expand') : t('collapse')}
                    >
                      {state.reposCollapsed ? t('expand') : t('collapse')}
                    </button>
                  </SectionHead>
                  <ul className={styles.repos}>
                    {(state.reposCollapsed ? (selected === undefined ? [] : [selected]) : state.repos).map(repo => (
                      <li key={repo.path}>
                        <RepoRow
                          t={t}
                          repo={repo}
                          selected={repo.path === state.selected}
                          onSelect={() => { git.select(repo.path) }}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            {state.truncated ? <p className={styles.footnote}>{t('cut')}</p> : null}
            {state.repos.length > 0 && state.selected === null
              ? <p className={styles.notice}>{t('selectHint')}</p>
              : null}
            {selected === undefined ? null : (
              <>
                <div className={styles.detailHead}>
                  <span className={styles.detailName}>{selected.name}</span>
                  <span className={styles.detailBranch}>
                    {selected.detached ? t('detached') : selected.branch ?? '—'}
                    {selected.upstream === null ? '' : ` → ${selected.upstream}`}
                  </span>
                  <span className={styles.detailCounts}>{counts(t, selected)}</span>
                </div>
                {state.actionFailure === null ? null : <Failure t={t} failure={state.actionFailure} />}
                {state.detail !== null && state.detail.message !== null
                  ? <p className={styles.failure} role="status">{t('failed', { message: state.detail.message })}</p>
                  : null}
                <CommitBox t={t} state={state} actions={git} />
                <div className={styles.scroll}>
                  {status === null ? null : <Changes t={t} status={status} actions={git} capabilities={capabilities} />}
                  <Compared t={t} state={state} actions={git} />
                  <Graph t={t} state={state} actions={git} />
                </div>
              </>
            )}
          </>
        )}
    </div>
  )
}

/** The diff payload's type, re-exported for the checks that read it. */
export type { DiffPayload, CommitSummary }
