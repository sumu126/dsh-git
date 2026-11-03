/**
 * Pure readers for the git plumbing output this plugin asks for.
 *
 * Every function here takes the exact bytes of one command and answers a value;
 * none of them runs a process, touches the filesystem, or reads a clock. That is
 * what lets the awkward cases — a rename, a conflict, a path with a space, a
 * detached HEAD — be pinned by a unit test instead of by a live repository.
 *
 * @module dsh-git/src/parse
 */

import type { BranchSummary, CommitSummary, DiffFile, RemoteSummary, StatusFile } from './contract.ts'

/** A parsed `git status --porcelain=v2 --branch` document. */
export interface ParsedStatus {
  /** Current branch name, or null on a detached HEAD. */
  branch: string | null
  /** True when HEAD is detached. */
  detached: boolean
  /** Abbreviated HEAD object name, or null before the first commit. */
  head: string | null
  /** Configured upstream branch. */
  upstream: string | null
  /** Commits the upstream does not have. */
  ahead: number
  /** Commits the local branch does not have. */
  behind: number
  /** Every changed path, in git's own order. */
  files: StatusFile[]
}

/** Split a NUL or newline terminated document into non-empty records. */
function records(text: string, separator: string): string[] {
  return text.split(separator).filter(record => record.length > 0)
}

/** Strip one trailing line ending, which git writes and the caller does not want. */
export function stripEol(text: string): string {
  return text.replace(/\r?\n$/, '')
}

/**
 * Strip the line endings around one `%x1e`-separated record.
 *
 * git writes a newline *after* each record separator, so every record but the
 * first arrives with a leading newline — which would otherwise make the first
 * field (`refname`, `hash`) start with `\n` and every prefix test against it
 * false.
 */
function cleanRecord(record: string): string {
  return record.replace(/^[\r\n]+/u, '').replace(/\r?\n$/u, '')
}

/**
 * Decode one path as git prints it outside `-z` mode.
 *
 * With `core.quotePath=false` a non-ASCII name is already literal, but a name
 * holding a quote, a backslash, a tab, or a newline is still C-quoted — and a
 * quoted name would otherwise appear in the panel with its quotes and escapes
 * intact.
 * @param raw - the path exactly as printed.
 * @returns the path itself.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const inner = raw.slice(1, -1)
  let out = ''
  // Octal escapes spell bytes, not code points: one UTF-8 character can be three
  // of them, so consecutive escapes are gathered and decoded together.
  const bytes: number[] = []
  const flush = (): void => {
    if (bytes.length === 0) return
    out += new TextDecoder().decode(new Uint8Array(bytes))
    bytes.length = 0
  }
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index] ?? ''
    if (char !== '\\') {
      flush()
      out += char
      continue
    }
    const escape = inner[index + 1] ?? ''
    index += 1
    if (escape >= '0' && escape <= '7') {
      // Up to three octal digits spell one byte of the UTF-8 path.
      let octal = escape
      while (octal.length < 3) {
        const next = inner[index + 1] ?? ''
        if (next < '0' || next > '7') break
        octal += next
        index += 1
      }
      bytes.push(Number.parseInt(octal, 8))
      continue
    }
    flush()
    if (escape === 'n') out += '\n'
    else if (escape === 't') out += '\t'
    else if (escape === 'r') out += '\r'
    else if (escape === 'a') out += '\u0007'
    else if (escape === 'b') out += '\b'
    else if (escape === 'f') out += '\f'
    else if (escape === 'v') out += '\v'
    else out += escape
  }
  flush()
  return out
}

/** The status letters of one entry, as a pair. */
function letters(xy: string): { index: string, worktree: string } {
  return { index: xy[0] ?? '.', worktree: xy[1] ?? '.' }
}

/**
 * Read one `git status --porcelain=v2 --branch` document.
 *
 * Version 2 is what makes this tractable: every entry declares its kind, so a
 * path is never guessed from a column position, and the branch header carries
 * upstream ahead/behind without a second command.
 * @param stdout - the command's standard output.
 * @returns the branch, its upsteam counts, and every changed path.
 */
export function parseStatusV2(stdout: string): ParsedStatus {
  const parsed: ParsedStatus = {
    branch: null, detached: false, head: null, upstream: null, ahead: 0, behind: 0, files: [],
  }
  for (const line of records(stdout, '\n')) {
    if (line.startsWith('# ')) {
      const space = line.indexOf(' ', 2)
      const key = space === -1 ? line.slice(2) : line.slice(2, space)
      const value = space === -1 ? '' : line.slice(space + 1)
      if (key === 'branch.oid') parsed.head = value === '(initial)' ? null : value.slice(0, 7)
      else if (key === 'branch.head') {
        if (value === '(detached)') parsed.detached = true
        else parsed.branch = value
      } else if (key === 'branch.upstream') parsed.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+)\s+-(\d+)$/u.exec(value.trim())
        if (match !== null) {
          parsed.ahead = Number(match[1])
          parsed.behind = Number(match[2])
        }
      }
      continue
    }
    const kind = line[0]
    if (kind === '1') {
      const fields = line.split(' ')
      if (fields.length < 9) continue
      const status = letters(fields[1] ?? '..')
      parsed.files.push({
        path: unquoteGitPath(fields.slice(8).join(' ')),
        index: status.index,
        worktree: status.worktree,
        kind: 'changed',
      })
    } else if (kind === '2') {
      const fields = line.split(' ')
      if (fields.length < 10) continue
      const status = letters(fields[1] ?? '..')
      const joined = unquoteGitPath(fields.slice(9).join(' '))
      const tab = joined.indexOf('\t')
      const path = tab === -1 ? joined : joined.slice(0, tab)
      const origPath = tab === -1 ? undefined : joined.slice(tab + 1)
      parsed.files.push({
        path,
        ...origPath === undefined ? {} : { origPath },
        index: status.index,
        worktree: status.worktree,
        kind: status.index === 'C' ? 'copied' : 'renamed',
      })
    } else if (kind === 'u') {
      const fields = line.split(' ')
      if (fields.length < 11) continue
      const status = letters(fields[1] ?? 'UU')
      parsed.files.push({
        path: unquoteGitPath(fields.slice(10).join(' ')),
        index: status.index,
        worktree: status.worktree,
        kind: 'unmerged',
      })
    } else if (kind === '?') {
      parsed.files.push({
        path: unquoteGitPath(line.slice(2)),
        index: '.',
        worktree: '?',
        kind: 'untracked',
      })
    } else if (kind === '!') {
      parsed.files.push({
        path: unquoteGitPath(line.slice(2)),
        index: '.',
        worktree: '!',
        kind: 'ignored',
      })
    }
  }
  return parsed
}

/**
 * Count the four kinds of change one status holds.
 *
 * A path counts in every category it belongs to, so a file with a staged edit
 * and a further unstaged edit is both staged and unstaged — which is what the
 * panel has to show to explain why committing would not finish the change.
 * @param files - every changed path.
 * @returns the four counts.
 */
export function countStatus(files: readonly StatusFile[]): {
  staged: number, unstaged: number, untracked: number, conflicted: number
} {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  for (const file of files) {
    if (file.kind === 'untracked') {
      untracked += 1
      continue
    }
    if (file.kind === 'unmerged') {
      conflicted += 1
      continue
    }
    if (file.index !== '.' && file.index !== ' ') staged += 1
    if (file.worktree !== '.' && file.worktree !== ' ') unstaged += 1
  }
  return { staged, unstaged, untracked, conflicted }
}

/**
 * Read one `git log --format=...` document.
 *
 * Records are separated by `%x1e` and fields by `%x1f`, both of which a commit
 * subject cannot contain because git forbids control characters in a subject.
 * @param stdout - the command's standard output.
 * @param options - `parents` reads the extra trailing field `%P` writes.
 * @returns every commit, in the order git printed them.
 */
export function parseLog(stdout: string, options: { parents?: boolean } = {}): CommitSummary[] {
  const commits: CommitSummary[] = []
  for (const record of records(stdout, '\x1e')) {
    const line = cleanRecord(record)
    if (line.length === 0) continue
    const fields = line.split('\x1f')
    const [hash, short, author, email, date, timestamp, subject, refs, parents] = fields
    if (hash === undefined || short === undefined || subject === undefined) continue
    commits.push({
      hash,
      short,
      author: author ?? '',
      email: email ?? '',
      date: date ?? '',
      timestamp: Number.parseInt(timestamp ?? '0', 10) || 0,
      subject,
      refs: (refs ?? '').split(',').map(ref => ref.trim()).filter(ref => ref.length > 0),
      parents: options.parents === true ? (parents ?? '').split(' ').filter(parent => parent.length > 0) : [],
    })
  }
  return commits
}

/** The `%(upstream:track)` field, as git words it. */
export function parseUpstreamTrack(track: string): { ahead: number, behind: number, gone: boolean } {
  const trimmed = track.trim()
  const gone = /\[gone\]/u.test(trimmed)
  const ahead = /ahead (\d+)/u.exec(trimmed)
  const behind = /behind (\d+)/u.exec(trimmed)
  return {
    ahead: ahead === null ? 0 : Number(ahead[1]),
    behind: behind === null ? 0 : Number(behind[1]),
    gone,
  }
}

/**
 * Read one `git for-each-ref` document built from the format this plugin asks for.
 *
 * The first field is the full refname, so a branch whose own name contains a
 * slash (`feat/x`) is still told apart from a remote-tracking branch: only the
 * refname prefix says which namespace a ref lives in.
 * @param stdout - the command's standard output.
 * @returns every branch, local and remote-tracking, in git's order.
 */
export function parseBranches(stdout: string): BranchSummary[] {
  const branches: BranchSummary[] = []
  for (const record of records(stdout, '\x1e')) {
    const line = cleanRecord(record)
    if (line.length === 0) continue
    const fields = line.split('\x1f')
    const [refname, short, sha, upstream, track, head, date, subject] = fields
    if (refname === undefined || short === undefined) continue
    const parsedTrack = parseUpstreamTrack(track ?? '')
    const upstreamName = (upstream ?? '').trim()
    branches.push({
      name: short,
      local: refname.startsWith('refs/heads/'),
      current: (head ?? '').trim() === '*',
      upstream: upstreamName.length === 0 ? null : upstreamName,
      ahead: parsedTrack.ahead,
      behind: parsedTrack.behind,
      track: upstreamName.length === 0 ? 'untracked' : parsedTrack.gone ? 'gone' : 'tracked',
      sha: sha ?? '',
      date: date ?? '',
      subject: subject ?? '',
    })
  }
  return branches
}

/**
 * Read one `git diff --name-status` document.
 *
 * A rename prints three fields (`R100`, the old path, the new one) and every
 * other status prints two, so the status letter — not the field count — decides
 * which shape a line is.
 * @param stdout - the command's standard output.
 * @returns every changed path, in git's order.
 */
export function parseNameStatus(stdout: string): DiffFile[] {
  const files: DiffFile[] = []
  for (const line of records(stdout, '\n')) {
    const clean = stripEol(line)
    if (clean.length === 0) continue
    const fields = clean.split('\t')
    const status = fields[0] ?? ''
    if (status.length === 0) continue
    if (status[0] === 'R' || status[0] === 'C') {
      const origPath = unquoteGitPath(fields[1] ?? '')
      const path = unquoteGitPath(fields[2] ?? origPath)
      files.push({ status, path, ...origPath.length === 0 ? {} : { origPath } })
    } else {
      files.push({ status, path: unquoteGitPath(fields[1] ?? '') })
    }
  }
  return files
}

/**
 * Read one `git diff --name-status -z` document.
 *
 * The NUL-terminated form is what a path holding a tab or a newline needs, and
 * it is the form the plugin uses for its own reads.
 * @param stdout - the command's standard output.
 * @returns every changed path, in git's order.
 */
export function parseNameStatusZ(stdout: string): DiffFile[] {
  const fields = stdout.split('\0')
  const files: DiffFile[] = []
  for (let index = 0; index < fields.length; index++) {
    const status = fields[index] ?? ''
    if (status.length === 0) continue
    if (status[0] === 'R' || status[0] === 'C') {
      const origPath = fields[index + 1] ?? ''
      const path = fields[index + 2] ?? origPath
      index += 2
      files.push({ status, path, ...origPath.length === 0 ? {} : { origPath } })
    } else {
      const path = fields[index + 1] ?? ''
      index += 1
      if (path.length > 0) files.push({ status, path })
    }
  }
  return files
}

/**
 * Read one `git diff --shortstat` line.
 * @param stdout - the command's standard output.
 * @returns the file, insertion, and deletion totals, zero when it printed nothing.
 */
export function parseShortStat(stdout: string): { files: number, additions: number, deletions: number } {
  const text = stdout.trim()
  const files = /(\d+) files? changed/u.exec(text)
  const additions = /(\d+) insertions?\(\+\)/u.exec(text)
  const deletions = /(\d+) deletions?\(-\)/u.exec(text)
  return {
    files: files === null ? 0 : Number(files[1]),
    additions: additions === null ? 0 : Number(additions[1]),
    deletions: deletions === null ? 0 : Number(deletions[1]),
  }
}

/**
 * Read one `git remote -v` document.
 * @param stdout - the command's standard output.
 * @returns every remote with its fetch and push URLs.
 */
export function parseRemotes(stdout: string): RemoteSummary[] {
  const byName = new Map<string, RemoteSummary>()
  for (const line of records(stdout, '\n')) {
    const match = /^(\S+)\t(\S+)\s+\((fetch|push)\)$/u.exec(stripEol(line))
    if (match === null) continue
    const [, name, url, direction] = match
    if (name === undefined || url === undefined) continue
    const entry = byName.get(name) ?? { name, fetch: '', push: '' }
    if (direction === 'fetch') entry.fetch = url
    else entry.push = url
    byName.set(name, entry)
  }
  return [...byName.values()]
}

/**
 * Split a `git status --porcelain=v2 --branch` document into its header lines
 * and entries.
 *
 * Exposed for the checks that want to assert on the raw shape rather than on a
 * parsed value.
 * @param stdout - the command's standard output.
 * @returns the header lines and the entry lines.
 */
export function splitStatusLines(stdout: string): { headers: string[], entries: string[] } {
  const headers: string[] = []
  const entries: string[] = []
  for (const line of records(stdout, '\n')) {
    if (line.startsWith('# ')) headers.push(line)
    else entries.push(line)
  }
  return { headers, entries }
}
