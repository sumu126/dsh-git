/**
 * One file's diff, as its own tab.
 *
 * The panel lists what changed; the diff itself does not fit the column it is
 * listed in. Clicking a file opens this tab: a header with the path and the line
 * totals, a side-by-side comparison with both line numbers (or a unified view for
 * a narrow pane), and its own scroll, so a large patch is read rather than
 * squeezed.
 *
 * The tab is opened with `params` — repository, path, comparison — so several
 * files can be open at once and each tab keeps the comparison it was opened for.
 *
 * @module dsh-git/src/client/DiffTab
 */

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { GIT_DIFF_PATH, type DiffAnswer, type DiffPayload, type GitDiffTabParams } from '../contract.ts'
import { readJson } from './api.ts'
import { fileBadge, splitPath } from './file-badge.ts'
import { parseDiff, markChanged, type DiffHunk, type DiffSegment } from './diff-view.ts'
import styles from './diff.module.css'

/** This tab's copy binder. */
type Translate = PropsLocale<'panel.git'>['t']

/** What the presentational diff needs. */
export interface DiffViewProps {
  /** The panel's copy binder. */
  t: Translate
  /** The file's path, relative to the repository root. */
  path: string
  /** The repository's own name, for the breadcrumb. */
  repoName?: string
  /** What the file is compared against, such as a commit's short object name. */
  label?: string
  /** Added lines, as the diff route counted them. */
  additions: number
  /** Removed lines. */
  deletions: number
  /** The unified patch text. */
  patch: string
}

/** One side of a changed line, with the words that changed marked. */
function ChangedLine({ segments, side }: { segments: readonly DiffSegment[], side: 'left' | 'right' }): ReactNode {
  return (
    <>
      {segments.map((segment, index) => segment.changed
        ? (
          <span
            key={String(index)}
            className={side === 'left' ? styles.changedDel : styles.changedAdd}
          >
            {segment.text}
          </span>
        )
        : <Fragment key={String(index)}>{segment.text}</Fragment>)}
    </>
  )
}

/** One hunk's rows, drawn side by side. */
function SplitHunk({ hunk }: { hunk: DiffHunk }): ReactNode {
  return (
    <>
      <div className={styles.hunkHeader}>{hunk.header}</div>
      {hunk.rows.map((row, index) => {
        const changed = row.left.kind === 'del' && row.right.kind === 'add'
        const marked = changed ? markChanged(row.left.text, row.right.text) : undefined
        return (
          <div key={String(index)} className={styles.splitRow}>
            <span className={`${styles.num} ${row.left.kind === 'none' ? styles.numBlank : ''}`}>{row.left.number ?? ''}</span>
            <span className={`${styles.cell} ${row.left.kind === 'del' ? styles.del : row.left.kind === 'none' ? styles.blank : ''}`}>
              {marked === undefined ? row.left.text : <ChangedLine segments={marked.left} side="left" />}
            </span>
            <span className={`${styles.num} ${row.right.kind === 'none' ? styles.numBlank : ''}`}>{row.right.number ?? ''}</span>
            <span className={`${styles.cell} ${row.right.kind === 'add' ? styles.add : row.right.kind === 'none' ? styles.blank : ''}`}>
              {marked === undefined ? row.right.text : <ChangedLine segments={marked.right} side="right" />}
            </span>
          </div>
        )
      })}
    </>
  )
}

/** One hunk's rows, drawn as one stream. */
function UnifiedHunk({ hunk }: { hunk: DiffHunk }): ReactNode {
  return (
    <>
      <div className={styles.hunkHeader}>{hunk.header}</div>
      {hunk.rows.map((row, index) => (
        <Fragment key={String(index)}>
          {row.left.kind === 'context'
            ? (
              <div className={styles.unifiedRow}>
                <span className={styles.num}>{row.left.number}</span>
                <span className={styles.num}>{row.right.number}</span>
                <span className={styles.cell}>{row.left.text}</span>
              </div>
            )
            : (
              <>
                {row.left.kind !== 'del'
                  ? null
                  : (
                    <div className={styles.unifiedRow}>
                      <span className={styles.num}>{row.left.number}</span>
                      <span className={styles.num} />
                      <span className={`${styles.cell} ${styles.del}`}>{row.left.text}</span>
                    </div>
                  )}
                {row.right.kind !== 'add'
                  ? null
                  : (
                    <div className={styles.unifiedRow}>
                      <span className={styles.num} />
                      <span className={styles.num}>{row.right.number}</span>
                      <span className={`${styles.cell} ${styles.add}`}>{row.right.text}</span>
                    </div>
                  )}
              </>
            )}
        </Fragment>
      ))}
    </>
  )
}

/**
 * Render one file's diff, side by side by default.
 *
 * Presentational on purpose: it takes the patch, not a repository, so the render
 * check can drive it with fixture text.
 * @param props - the path, the totals, the patch, and the copy binder.
 * @returns the header and the hunks, in the chosen layout.
 */
export function DiffView({ t, path, repoName, label, additions, deletions, patch }: DiffViewProps): ReactNode {
  const [split, setSplit] = useState(true)
  const parsed = useMemo(() => parseDiff(patch), [patch])
  const badge = fileBadge(path)
  const { directory, name } = splitPath(path)
  // The breadcrumb a diff editor shows: where the file lives, from the repository
  // down. The name is last because that is what the reader already knows.
  const trail = [
    ...repoName === undefined || repoName.length === 0 ? [] : [repoName],
    ...directory.length === 0 ? [] : directory.split('/'),
  ]
  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <span className={styles.crumbs}>
          {trail.map((part, index) => (
            <Fragment key={`${part}-${String(index)}`}>
              {index === 0 ? null : <span className={styles.sep}>›</span>}
              <span className={styles.crumb}>{part}</span>
            </Fragment>
          ))}
          {trail.length === 0 ? null : <span className={styles.sep}>›</span>}
          <span className={`${styles.badge} ${styles[`tone-${badge.tone}`] ?? ''}`}>{badge.label}</span>
          <span className={styles.name}>{name}</span>
        </span>
        {label === undefined || label.length === 0 ? null : <span className={styles.label}>{label}</span>}
        <span className={styles.counts}>
          <span className={styles.additions}>+{additions}</span>
          <span className={styles.deletions}>−{deletions}</span>
        </span>
        <span className={styles.modes}>
          <button type="button" className={split ? styles.modeActive : styles.mode} onClick={() => { setSplit(true) }}>{t('diffSplit')}</button>
          <button type="button" className={split ? styles.mode : styles.modeActive} onClick={() => { setSplit(false) }}>{t('diffUnified')}</button>
        </span>
      </header>
      <div className={styles.body}>
        {parsed.hunks.length === 0
          ? <p className={styles.note}>{t('noChanges')}</p>
          : parsed.hunks.map(hunk => (
            <section key={hunk.header} className={styles.hunk}>
              {split ? <SplitHunk hunk={hunk} /> : <UnifiedHunk hunk={hunk} />}
            </section>
          ))}
      </div>
    </div>
  )
}

/** What one diff tab's read left behind. */
type DiffState =
  | { phase: 'loading' }
  | { phase: 'failed', message: string }
  | { phase: 'ready', diff: DiffPayload }

/**
 * Render one file's diff tab: it reads the patch for the file the tab was opened
 * with, and keeps the tab's own comparison.
 * @param props - the tab's runtime seat and the copy binder.
 * @returns the diff, or what went wrong reading it.
 */
export function DiffTab({ t, useTabInfo }: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'panel.git'>): ReactNode {
  const { tab } = useTabInfo()
  const params = tab.navigation.params as GitDiffTabParams | undefined
  const repo = params?.repo ?? ''
  const path = params?.path ?? ''
  const scope = params?.scope ?? 'working'
  const ref = params?.ref ?? ''
  const [state, setState] = useState<DiffState>({ phase: 'loading' })

  useEffect(() => {
    if (repo.length === 0 || path.length === 0) {
      setState({ phase: 'failed', message: 'no-file' })
      return
    }
    const controller = new AbortController()
    setState({ phase: 'loading' })
    readJson<DiffAnswer>(
      GIT_DIFF_PATH,
      { repo, path, scope, ...ref.length === 0 ? {} : { ref } },
      controller.signal,
    ).then((answer) => {
      if (controller.signal.aborted) return
      setState(answer.diff === undefined
        ? { phase: 'failed', message: answer.message ?? '' }
        : { phase: 'ready', diff: answer.diff })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setState({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { controller.abort() }
  }, [repo, path, scope, ref])

  if (state.phase === 'loading') return <p className={styles.note}>{t('loading')}</p>
  if (state.phase === 'failed') {
    return (
      <p className={styles.failure} role="status">
        {state.message === 'HTTP 404' ? t('hostStale') : t('failed', { message: state.message })}
      </p>
    )
  }
  return (
    <DiffView
      t={t}
      path={path}
      repoName={splitPath(repo).name}
      label={comparisonLabel(t, params)}
      additions={state.diff.additions}
      deletions={state.diff.deletions}
      patch={state.diff.patch}
    />
  )
}

/**
 * What one tab's file is compared against, as its chip and header show it.
 * @param t - the copy binder.
 * @param params - the tab's navigation parameters.
 * @returns the commit's short name, or the comparison's name.
 */
function comparisonLabel(t: Translate, params: GitDiffTabParams | undefined): string {
  const scope = params?.scope ?? 'working'
  if (scope === 'commit') {
    const ref = params?.ref ?? ''
    return ref.length >= 7 ? ref.slice(0, 7) : ref
  }
  return scope === 'staged' ? t('scopeStaged') : t('scopeWorking')
}

/**
 * Render the tab's chip title: the file's own name, and what it is compared
 * against.
 * @param props - the title seat's tab information and the copy binder.
 * @returns the chip's text, or nothing while the tab carries no file.
 */
export function DiffTabTitle({ t, useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'panel.git'>): ReactNode {
  const { tab } = useTabInfo()
  const params = tab.navigation.params as GitDiffTabParams | undefined
  const path = params?.path ?? ''
  if (path.length === 0) return null
  const label = comparisonLabel(t, params)
  const name = splitPath(path).name
  return label.length === 0 ? name : `${name} (${label})`
}
