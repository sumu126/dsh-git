/**
 * Tool-call rows for this plugin's tools.
 *
 * Registering a key is a takeover rather than an addition: once `git_status` is
 * claimed, every state of that call — still running, failed, dispatched inside
 * another call, or carrying metadata this version cannot read — renders here. So
 * each view has a real fallback branch of its own instead of assuming the card is
 * there, and the fallback row answers a string for every shape it is handed.
 *
 * @module dsh-git/src/client/GitToolRows
 */

import type { ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  TOOL_ROW_KEYS, callText, errorText, gitCardModel,
  type CardCounts, type CardFile, type GitCard,
} from './card-model.ts'
import { TOOL_NS, type ToolLocaleKey } from './locales.ts'
import styles from './rows.module.css'

/** Props the renderer binds for one row this plugin owns. */
type GitRowProps = ToolCallViewProps & PropsLocale<typeof TOOL_NS>

/** The copy binder a row receives. */
type Translate = (key: ToolLocaleKey, params?: Record<string, string>) => string

/** The heading one card draws. */
function heading(t: Translate, card: GitCard): string {
  switch (card.kind) {
    case 'repos': return t('reposTitle')
    case 'status': return t('statusTitle')
    case 'log': return t('logTitle')
    case 'diff': return t('diffTitle')
    case 'commit': return t('commitTitle')
    case 'branches': return t('branchesTitle')
    case 'remotes': return t('remotesTitle')
    case 'action': return t('actionTitle')
  }
}

/** The change counts, as one phrase. */
function countsPhrase(t: Translate, counts: CardCounts): string {
  const parts: string[] = []
  if (counts.staged > 0) parts.push(`${String(counts.staged)} ${t('staged')}`)
  if (counts.unstaged > 0) parts.push(`${String(counts.unstaged)} ${t('unstaged')}`)
  if (counts.untracked > 0) parts.push(`${String(counts.untracked)} ${t('untracked')}`)
  if (counts.conflicted > 0) parts.push(`${String(counts.conflicted)} ${t('conflicted')}`)
  return parts.join(' · ')
}

/** One changed path, as a row draws it. */
function FileLine({ file }: { file: CardFile }): ReactNode {
  return (
    <li className={styles.line}>
      <span className={styles.letters}>{file.letters}</span>
      <span className={styles.path}>{file.path}</span>
      {file.origPath === undefined ? null : <span className={styles.muted}>← {file.origPath}</span>}
    </li>
  )
}

/** A list of changed paths, or the copy that says there are none. */
function FileList({ t, files }: { t: Translate, files: CardFile[] }): ReactNode {
  if (files.length === 0) return <p className={styles.note}>{t('noFiles')}</p>
  return <ul className={styles.list}>{files.map(file => <FileLine key={`${file.letters}:${file.path}`} file={file} />)}</ul>
}

/** The row drawn for every state the cards do not own. */
function FallbackRow({ toolName, block, t }: { toolName: string, block: ToolCallBlock, t: Translate }): ReactNode {
  const text = (errorText(block) || callText(block)) ?? ''
  const title = typeof toolName === 'string' && toolName.length > 0 ? toolName : t('statusTitle')
  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <span className={styles.title}>{title}</span>
      </div>
      {text.length === 0 ? null : <pre className={styles.plain}>{text}</pre>}
    </div>
  )
}

/** The body one card draws, below its heading. */
function Body({ card, t }: { card: GitCard, t: Translate }): ReactNode {
  switch (card.kind) {
    case 'repos':
      if (card.repos.length === 0) return <p className={styles.note}>{t('noFiles')}</p>
      return (
        <ul className={styles.list}>
          {card.repos.map(repo => (
            <li key={repo.path} className={styles.line}>
              <span className={styles.name}>{repo.name}</span>
              <span className={styles.muted}>{repo.branch ?? '—'}</span>
              {repo.changes === 0 ? null : <span className={styles.muted}>{String(repo.changes)}</span>}
            </li>
          ))}
        </ul>
      )
    case 'status':
      return <FileList t={t} files={card.files} />
    case 'action':
      return <p className={styles.note}>{countsPhrase(t, card.counts) || t('noFiles')}</p>
    case 'log':
      if (card.commits.length === 0) return <p className={styles.note}>{t('noFiles')}</p>
      return (
        <ul className={styles.list}>
          {card.commits.map(commit => (
            <li key={commit.short} className={styles.line}>
              <span className={styles.letters}>{commit.short}</span>
              <span className={styles.path}>{commit.subject}</span>
              <span className={styles.muted}>{commit.author}</span>
            </li>
          ))}
        </ul>
      )
    case 'diff':
      return <FileList t={t} files={card.files} />
    case 'commit':
      return (
        <>
          <p className={styles.note}>{card.subject}</p>
          <FileList t={t} files={card.files} />
        </>
      )
    case 'branches':
      if (card.branches.length === 0) return <p className={styles.note}>{t('noFiles')}</p>
      return (
        <ul className={styles.list}>
          {card.branches.map(branch => (
            <li key={branch.name} className={styles.line}>
              <span className={styles.letters}>{branch.current ? '*' : ' '}</span>
              <span className={styles.name}>{branch.name}</span>
              {branch.track === 'gone' ? <span className={styles.muted}>{t('gone')}</span> : null}
              {branch.ahead === 0 && branch.behind === 0 ? null : (
                <span className={styles.muted}>
                  {branch.ahead > 0 ? `↑${String(branch.ahead)}` : ''}
                  {branch.behind > 0 ? `↓${String(branch.behind)}` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      )
    case 'remotes':
      if (card.remotes.length === 0) return <p className={styles.note}>{t('noFiles')}</p>
      return (
        <ul className={styles.list}>
          {card.remotes.map(remote => (
            <li key={remote.name} className={styles.line}>
              <span className={styles.name}>{remote.name}</span>
              <span className={styles.muted}>{remote.fetch}</span>
            </li>
          ))}
        </ul>
      )
  }
}

/**
 * The row for one git call.
 * @param props - the call, the tool's wire name, and the localized copy.
 * @returns the card, or the generic row for a state this card does not own.
 */
export function GitRow(props: GitRowProps): ReactNode {
  const { toolName, block, t } = props
  const card = gitCardModel(block)
  if (card === null) return <FallbackRow toolName={toolName} block={block} t={t} />
  const total = 'total' in card ? card.total : 0
  return (
    <div className={styles.row}>
      <div className={styles.head}>
        <span className={styles.title}>{heading(t, card)}</span>
        {'repo' in card && card.repo.length > 0 ? <span className={styles.muted}>{card.repo}</span> : null}
        {card.kind === 'diff'
          ? (
            <span className={styles.counts}>
              {t('additions', { count: String(card.additions) })} {t('deletions', { count: String(card.deletions) })}
            </span>
          )
          : null}
        {card.kind === 'status' || card.kind === 'action'
          ? <span className={styles.counts}>{countsPhrase(t, card.counts)}</span>
          : null}
        {'total' in card && total > 0 ? <span className={styles.count}>{t('files', { count: String(total) })}</span> : null}
        {card.truncated ? <span className={styles.badge}>{t('cut')}</span> : null}
      </div>
      <Body card={card} t={t} />
    </div>
  )
}

/**
 * Register the rows this plugin draws.
 *
 * The keys are wire tool names, so a tool this plugin does not claim keeps the
 * shell's generic row.
 * @param ctx - browser plugin context.
 */
export function registerToolRows(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of TOOL_ROW_KEYS) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: TOOL_NS }, GitRow)
    }
  })
}
