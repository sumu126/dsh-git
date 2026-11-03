/**
 * Card models derived from the metadata the host persists for a git tool call.
 *
 * Pure by construction: it imports no React, no CSS, and no browser global, so a
 * Node check can import this module directly and feed it foreign shapes. A client
 * replays sessions older versions recorded, so every field is re-checked rather
 * than trusted — and a value this version cannot read answers null, which makes
 * the owning row fall back to the generic one instead of throwing.
 *
 * @module dsh-git/src/client/card-model
 */

import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'

/** One changed path a card draws. */
export interface CardFile {
  /** Path after the change. */
  path: string
  /** Path before a rename. */
  origPath?: string
  /** Status letters, as the metadata spelled them. */
  letters: string
}

/** One repository line a card draws. */
export interface CardRepo {
  /** Directory name. */
  name: string
  /** Absolute path. */
  path: string
  /** Current branch. */
  branch: string | null
  /** Commits ahead of the upstream. */
  ahead: number
  /** Commits behind the upstream. */
  behind: number
  /** Changed paths, all categories together. */
  changes: number
}

/** One commit line a card draws. */
export interface CardCommit {
  /** Abbreviated object name. */
  short: string
  /** Subject line. */
  subject: string
  /** Author name. */
  author: string
  /** Author date. */
  date: string
  /** Ref names pointing at the commit. */
  refs: string[]
}

/** One branch line a card draws. */
export interface CardBranch {
  /** Branch name. */
  name: string
  /** Whether HEAD is on it. */
  current: boolean
  /** Commits ahead of the upstream. */
  ahead: number
  /** Commits behind the upstream. */
  behind: number
  /** tracked, gone, or untracked. */
  track: string
}

/** The change counts one status card draws. */
export interface CardCounts {
  /** Staged paths. */
  staged: number
  /** Unstaged paths. */
  unstaged: number
  /** Untracked paths. */
  untracked: number
  /** Unresolved conflicts. */
  conflicted: number
}

/** What one git call draws. */
export type GitCard =
  | { kind: 'repos', root: string, repos: CardRepo[], total: number, truncated: boolean }
  | {
    kind: 'status', repo: string, branch: string | null, detached: boolean, upstream: string | null,
    ahead: number, behind: number, counts: CardCounts, files: CardFile[], total: number, truncated: boolean,
  }
  | { kind: 'log', repo: string, commits: CardCommit[], total: number, truncated: boolean }
  | {
    kind: 'diff', repo: string, scope: string, ref?: string, additions: number, deletions: number,
    files: CardFile[], total: number, truncated: boolean,
  }
  | { kind: 'commit', repo: string, short: string, subject: string, author: string, files: CardFile[], total: number, truncated: boolean }
  | { kind: 'branches', repo: string, current: string | null, branches: CardBranch[], total: number, truncated: boolean }
  | { kind: 'remotes', repo: string, remotes: { name: string, fetch: string }[], total: number, truncated: boolean }
  | { kind: 'action', repo: string, branch: string | null, counts: CardCounts, truncated: boolean }

/**
 * The wire tool names this plugin draws cards for.
 *
 * It lives here rather than beside the views because the view module imports
 * CSS, which a plain Node run cannot load.
 */
export const TOOL_ROW_KEYS = [
  'git_repos', 'git_status', 'git_log', 'git_diff', 'git_show',
  'git_branches', 'git_remotes', 'git_stage', 'git_commit', 'git_switch',
] as const

/** Whether one value is the kind of object a field can be read off. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A non-negative integer. */
function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/** A string, when the host of that version sent one. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A count that may legitimately be absent, answered as zero. */
function countOrZero(value: unknown): number {
  return countOf(value) ?? 0
}

/** A boolean that may legitimately be absent. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** The change counts one status or action card carries. */
function countsOf(meta: Record<string, unknown>): CardCounts {
  return {
    staged: countOrZero(meta.staged),
    unstaged: countOrZero(meta.unstaged),
    untracked: countOrZero(meta.untracked),
    conflicted: countOrZero(meta.conflicted),
  }
}

/** One changed path, or nothing when the record is not one. */
function cardFile(value: unknown): CardFile | null {
  if (!isRecord(value)) return null
  const path = textOf(value.path)
  if (path === undefined) return null
  const origPath = textOf(value.origPath)
  const status = textOf(value.status)
  const index = textOf(value.index) ?? ''
  const worktree = textOf(value.worktree) ?? ''
  return {
    path,
    ...origPath === undefined ? {} : { origPath },
    letters: status ?? `${index}${worktree}`,
  }
}

/** A list of changed paths, or nothing when any entry is unreadable. */
function cardFiles(value: unknown): CardFile[] | null {
  if (!Array.isArray(value)) return null
  const files: CardFile[] = []
  for (const entry of value) {
    const file = cardFile(entry)
    if (file === null) return null
    files.push(file)
  }
  return files
}

/** One repository line, or nothing. */
function cardRepo(value: unknown): CardRepo | null {
  if (!isRecord(value)) return null
  const name = textOf(value.name)
  const path = textOf(value.path)
  if (name === undefined || path === undefined) return null
  const branch = value.branch === null ? null : textOf(value.branch) ?? null
  return {
    name,
    path,
    branch,
    ahead: countOrZero(value.ahead),
    behind: countOrZero(value.behind),
    changes: countOrZero(value.changes),
  }
}

/** One commit line, or nothing. */
function cardCommit(value: unknown): CardCommit | null {
  if (!isRecord(value)) return null
  const short = textOf(value.short)
  const subject = textOf(value.subject)
  if (short === undefined || subject === undefined) return null
  return {
    short,
    subject,
    author: textOf(value.author) ?? '',
    date: textOf(value.date) ?? '',
    refs: Array.isArray(value.refs) ? value.refs.filter((ref): ref is string => typeof ref === 'string') : [],
  }
}

/** One branch line, or nothing. */
function cardBranch(value: unknown): CardBranch | null {
  if (!isRecord(value)) return null
  const name = textOf(value.name)
  if (name === undefined) return null
  return {
    name,
    current: booleanOr(value.current, false),
    ahead: countOrZero(value.ahead),
    behind: countOrZero(value.behind),
    track: textOf(value.track) ?? 'untracked',
  }
}

/**
 * The card one settled call draws.
 * @param block - the frozen running-or-settled call node.
 * @returns the card, or nothing for every case the generic row owns: a call still
 * running, a failed one, a nested dispatch, or metadata this version cannot read.
 */
export function gitCardModel(block: ToolCallBlock): GitCard | null {
  if (!isRecord(block)) return null
  if (block.parentCallId !== undefined) return null
  if (!('kind' in block)) return null
  if (block.isError) return null
  if (!isRecord(block.meta)) return null
  const meta = block.meta
  if (meta.card !== 'git') return null
  // Every variant says whether it was cut; one that does not is metadata from a
  // version this row was not written against.
  if (typeof meta.truncated !== 'boolean') return null
  const truncated = meta.truncated
  const repo = textOf(meta.repo) ?? ''
  switch (meta.variant) {
    case 'repos': {
      if (!Array.isArray(meta.repos)) return null
      const repos: CardRepo[] = []
      for (const entry of meta.repos) {
        const parsed = cardRepo(entry)
        if (parsed === null) return null
        repos.push(parsed)
      }
      return {
        kind: 'repos', root: textOf(meta.root) ?? '', repos,
        total: countOrZero(meta.total), truncated,
      }
    }
    case 'status': {
      const files = cardFiles(meta.files)
      if (files === null) return null
      return {
        kind: 'status',
        repo,
        branch: meta.branch === null ? null : textOf(meta.branch) ?? null,
        detached: booleanOr(meta.detached, false),
        upstream: meta.upstream === null ? null : textOf(meta.upstream) ?? null,
        ahead: countOrZero(meta.ahead),
        behind: countOrZero(meta.behind),
        counts: countsOf(meta),
        files,
        total: countOrZero(meta.total),
        truncated,
      }
    }
    case 'log': {
      if (!Array.isArray(meta.commits)) return null
      const commits: CardCommit[] = []
      for (const entry of meta.commits) {
        const parsed = cardCommit(entry)
        if (parsed === null) return null
        commits.push(parsed)
      }
      return { kind: 'log', repo, commits, total: countOrZero(meta.total), truncated }
    }
    case 'diff': {
      const files = cardFiles(meta.files)
      if (files === null) return null
      const ref = textOf(meta.ref)
      return {
        kind: 'diff',
        repo,
        scope: textOf(meta.scope) ?? 'working',
        ...ref === undefined ? {} : { ref },
        additions: countOrZero(meta.additions),
        deletions: countOrZero(meta.deletions),
        files,
        total: countOrZero(meta.total),
        truncated,
      }
    }
    case 'commit': {
      const files = cardFiles(meta.files)
      if (files === null) return null
      const short = textOf(meta.short)
      if (short === undefined) return null
      return {
        kind: 'commit', repo, short,
        subject: textOf(meta.subject) ?? '',
        author: textOf(meta.author) ?? '',
        files,
        total: countOrZero(meta.total),
        truncated,
      }
    }
    case 'branches': {
      if (!Array.isArray(meta.branches)) return null
      const branches: CardBranch[] = []
      for (const entry of meta.branches) {
        const parsed = cardBranch(entry)
        if (parsed === null) return null
        branches.push(parsed)
      }
      return {
        kind: 'branches', repo,
        current: meta.current === null ? null : textOf(meta.current) ?? null,
        branches, total: countOrZero(meta.total), truncated,
      }
    }
    case 'remotes': {
      if (!Array.isArray(meta.remotes)) return null
      const remotes: { name: string, fetch: string }[] = []
      for (const entry of meta.remotes) {
        if (!isRecord(entry)) return null
        const name = textOf(entry.name)
        if (name === undefined) return null
        remotes.push({ name, fetch: textOf(entry.fetch) ?? '' })
      }
      return { kind: 'remotes', repo, remotes, total: countOrZero(meta.total), truncated }
    }
    case 'action':
      return {
        kind: 'action',
        repo,
        branch: meta.branch === null ? null : textOf(meta.branch) ?? null,
        counts: countsOf(meta),
        truncated,
      }
    default:
      return null
  }
}

/**
 * The text one call's result carries, for the generic row.
 * @param block - the frozen running-or-settled call node.
 * @returns the call's text blocks joined, empty when it carries none.
 */
export function genericText(block: ToolCallBlock): string {
  if (!isRecord(block) || !('kind' in block)) return ''
  // A block from a shell this bundle was not written against can carry anything
  // here, and a row that throws takes its whole group of tool calls down: the
  // shell catches the slot entry and draws nothing where the rows should be.
  if (!Array.isArray(block.content)) return ''
  const parts: string[] = []
  for (const part of block.content) {
    if (!isRecord(part)) continue
    const text = part.text
    if (part.type === 'text' && typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * One call's own text: its arguments while it still runs, its result text once
 * settled.
 *
 * The two generations spell a running call's arguments differently — 0.1.x hands
 * over `argsRaw`, 0.2.x hands over `args` — so both are read. Answering a string
 * no matter what is the point: an `undefined` here once threw inside a slot entry
 * and blanked every tool row of the turn.
 * @param block - the frozen running-or-settled call node.
 * @returns the text a generic row shows for this call.
 */
export function callText(block: ToolCallBlock): string {
  if (!isRecord(block)) return ''
  if ('kind' in block) return genericText(block)
  const raw = block.argsRaw
  if (typeof raw === 'string' && raw.length > 0) return raw
  const args = Reflect.get(block, 'args')
  if (typeof args === 'string') return args
  if (isRecord(args)) {
    try {
      return JSON.stringify(args)
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Why one call failed, for the generic row.
 * @param block - the frozen running-or-settled call node.
 * @returns the recorded reason or code, empty when the call did not fail.
 */
export function errorText(block: ToolCallBlock): string {
  if (!isRecord(block) || !('kind' in block)) return ''
  if (block.isError !== true) return ''
  const error = block.error
  if (!isRecord(error)) return ''
  const reason = error.reason
  if (typeof reason === 'string') return reason
  const code = error.code
  return typeof code === 'string' ? code : ''
}
