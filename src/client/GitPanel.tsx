/**
 * The right-sidebar Git panel: the repositories under one root, the selected
 * one's status, and the diff for the comparison the reader picked.
 *
 * One page, read-only. Changing a working tree is what the tools are for, and a
 * panel that could also stage would need an approval story of its own; this one
 * answers "what is here, what changed, and what does the change say".
 *
 * @module dsh-git/src/client/GitPanel
 */

import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DiffPayload, RepoStatus, RepoSummary } from '../contract.ts'
import type { GitPanelActions, GitPanelSnapshot } from './panel.ts'
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

/** One changed path. */
function FileRow({ file }: { file: RepoStatus['files'][number] }): ReactNode {
  const letters = file.kind === 'untracked' ? '??' : `${file.index}${file.worktree}`
  return (
    <li className={styles.file}>
      <span className={styles.letters} data-kind={file.kind}>{letters}</span>
      <span className={styles.filePath}>{file.path}</span>
      {file.origPath === undefined ? null : <span className={styles.origPath}>← {file.origPath}</span>}
    </li>
  )
}

/** The selected repository's detail: its status and one comparison. */
function Detail(
  { t, state, actions }: { t: GitPanelProps['t'], state: GitPanelSnapshot, actions: GitPanelActions },
): ReactNode {
  const detail = state.detail
  if (detail === null) return null
  if (detail.loading) return <p className={styles.notice} role="status">{t('loading')}</p>
  if (detail.message !== null) return <p className={styles.failure} role="status">{t('failed', { message: detail.message })}</p>
  const status = detail.status
  const diff = detail.diff
  return (
    <>
      {status === null ? null : (
        <section className={styles.section}>
          <header className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('changed')}</span>
            <span className={styles.sectionMeta}>{t('files', { count: String(status.files.length) })}</span>
          </header>
          {status.files.length === 0
            ? <p className={styles.notice}>{t('clean')}</p>
            : <ul className={styles.files}>{status.files.map(file => <FileRow key={`${file.kind}:${file.path}`} file={file} />)}</ul>}
          {status.filesTruncated
            ? <p className={styles.footnote}>{t('filesCut', { count: String(status.files.length) })}</p>
            : null}
        </section>
      )}
      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <span className={styles.sectionTitle}>{t('diff')}</span>
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
          {diff === null ? null : (
            <span className={styles.sectionMeta}>
              {diff.files.length === 0 ? t('noChanges') : `+${String(diff.additions)} −${String(diff.deletions)}`}
            </span>
          )}
        </header>
        {diff === null || diff.patch.length === 0
          ? <p className={styles.notice}>{t('noChanges')}</p>
          : <pre className={styles.patch}>{diff.patch}</pre>}
        {diff === null || diff.truncated === false
          ? null
          : <p className={styles.footnote}>{t('patchCut', { bytes: String(new TextEncoder().encode(diff.patch).length) })}</p>}
      </section>
    </>
  )
}

/**
 * Render the panel.
 * @param props - the panel's state and gestures, and the localized copy.
 * @returns the root picker, the repository list, and the selected repository's detail.
 */
export function GitPanel(props: GitPanelProps): ReactNode {
  const { t, useGitPanel, git } = props
  const state = useGitPanel(snapshot => snapshot)
  const selected = state.repos.find(repo => repo.path === state.selected)

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
                <ul className={styles.repos}>
                  {state.repos.map(repo => (
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
              )}
            {state.truncated ? <p className={styles.footnote}>{t('cut')}</p> : null}
            {state.repos.length > 0 && state.selected === null
              ? <p className={styles.notice}>{t('selectHint')}</p>
              : null}
            {selected === undefined ? null : (
              <div className={styles.detailHead}>
                <span className={styles.detailName}>{selected.name}</span>
                <span className={styles.detailBranch}>
                  {selected.detached ? t('detached') : selected.branch ?? '—'}
                  {selected.upstream === null ? '' : ` → ${selected.upstream}`}
                </span>
              </div>
            )}
            <div className={styles.scroll}>
              <Detail t={t} state={state} actions={git} />
            </div>
          </>
        )}
    </div>
  )
}

/** The diff payload's type, re-exported for the checks that read it. */
export type { DiffPayload }
