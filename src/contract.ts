/**
 * The wire contract between the two halves of this plugin.
 *
 * The host writes these values and the browser reads them; both import this
 * module, so a field renamed here is a compile error on both sides rather than a
 * panel that quietly shows nothing. Nothing in this file touches Node or the DOM.
 *
 * @module dsh-git/src/contract
 */

/** Authenticated route that lists the repositories under a root. */
export const GIT_REPOS_PATH = '/api/dsh-git/repos'

/** Authenticated route that lists the roots the panel may browse. */
export const GIT_ROOTS_PATH = '/api/dsh-git/roots'

/** Authenticated route that reads one repository's status. */
export const GIT_STATUS_PATH = '/api/dsh-git/status'

/** Authenticated route that reads one repository's diff. */
export const GIT_DIFF_PATH = '/api/dsh-git/diff'

/** Identity of the right-sidebar tab type this plugin contributes. */
export const GIT_TAB_ID = 'dsh-git'

/** Kind the panel is opened by; also its guide card's own id. */
export const GIT_TAB_KIND = 'git'

/** Identity of the tab type that shows one file's diff. */
export const GIT_FILE_TAB_ID = 'dsh-git-file'

/** Kind a file diff is opened by; each file gets its own tab. */
export const GIT_FILE_TAB_KIND = 'git-file'

/** What one file-diff tab is opened with. */
export interface GitDiffTabParams {
  /** The repository the file belongs to, by path. */
  repo: string
  /** The file's path, relative to the repository root. */
  path: string
  /** Which comparison to show. */
  scope: DiffScope
  /** The revision for the `commit` and `range` scopes. */
  ref?: string
}

/** One repository as the panel's list shows it. */
export interface RepoSummary {
  /** Absolute worktree (or git directory, for a bare repository) path. */
  path: string
  /** The directory's own name, for display. */
  name: string
  /** Current branch, or null on a detached HEAD. */
  branch: string | null
  /** True when HEAD is detached. */
  detached: boolean
  /** Abbreviated HEAD commit, or null before the first commit. */
  head: string | null
  /** Upstream branch name, when one is configured. */
  upstream: string | null
  /** Commits the upstream does not have. */
  ahead: number
  /** Commits the local branch does not have. */
  behind: number
  /** Files with a staged change. */
  staged: number
  /** Files with an unstaged change. */
  unstaged: number
  /** Untracked files. */
  untracked: number
  /** Files with an unresolved merge conflict. */
  conflicted: number
  /** True when any of the four counts above is non-zero. */
  dirty: boolean
}

/** One changed path in a working tree. */
export interface StatusFile {
  /** Path relative to the repository root. */
  path: string
  /** Previous path, for a rename or a copy. */
  origPath?: string
  /** Index status letter: `A`, `M`, `D`, `R`, `C`, `U`, or `.` for unchanged. */
  index: string
  /** Worktree status letter, with the same alphabet. */
  worktree: string
  /** What kind of entry this is, for the panel's grouping. */
  kind: 'changed' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored'
}

/** One repository's status. */
export interface RepoStatus {
  /** The repository this status belongs to. */
  repo: RepoSummary
  /** Changed paths, in the order git reported them. */
  files: StatusFile[]
  /** True when the file list was cut at the deployment's bound. */
  filesTruncated: boolean
}

/** One commit. */
export interface CommitSummary {
  /** Full object name. */
  hash: string
  /** Abbreviated object name. */
  short: string
  /** Author name. */
  author: string
  /** Author email. */
  email: string
  /** Author date, ISO 8601 with the author's offset. */
  date: string
  /** Author date, seconds since the epoch. */
  timestamp: number
  /** Subject line. */
  subject: string
  /** Ref names pointing at this commit, as `%(decorate)` prints them. */
  refs: string[]
  /** Parent object names, so a merge is visible as one. */
  parents: string[]
}

/** One branch, local or remote-tracking. */
export interface BranchSummary {
  /** Short name, such as `main` or `origin/main`. */
  name: string
  /** True for a local branch. */
  local: boolean
  /** True for the branch HEAD points at. */
  current: boolean
  /** Short name of the upstream branch, when one is configured. */
  upstream: string | null
  /** Commits the upstream does not have. */
  ahead: number
  /** Commits the branch does not have. */
  behind: number
  /** The upstream's state as git words it: tracked, gone, or untracked. */
  track: 'tracked' | 'gone' | 'untracked'
  /** Tip commit's abbreviated object name. */
  sha: string
  /** Committer date, ISO 8601. */
  date: string
  /** Tip commit's subject. */
  subject: string
}

/** One configured remote. */
export interface RemoteSummary {
  /** The remote's name. */
  name: string
  /** Fetch URL. */
  fetch: string
  /** Push URL. */
  push: string
}

/** One changed path in a diff. */
export interface DiffFile {
  /** Status letter as `--name-status` prints it: `A`, `M`, `D`, `R100`, or `U`. */
  status: string
  /** Path after the change. */
  path: string
  /** Path before the change, for a rename or a copy. */
  origPath?: string
}

/** The scope one diff covers. */
export type DiffScope = 'working' | 'staged' | 'commit' | 'range'

/** One diff, as a tool call and the panel both read it. */
export interface DiffPayload {
  /** The repository the diff came from. */
  repo: RepoSummary
  /** Which comparison this is. */
  scope: DiffScope
  /** The revision or range the diff compares, when the scope names one. */
  ref?: string
  /** Changed paths. */
  files: DiffFile[]
  /** Line totals over the whole diff, as `--shortstat` counts them. */
  additions: number
  /** Lines removed over the whole diff. */
  deletions: number
  /** The unified patch itself, bounded by the deployment's byte cap. */
  patch: string
  /** True when the patch was cut at the byte cap. */
  truncated: boolean
  /** Why there is nothing to show, when a refusal is a value rather than an error. */
  message?: string
}

/** One root the panel may browse for repositories. */
export interface RepoRoot {
  /** Absolute directory path. */
  path: string
  /** A name to show beside it. */
  title: string
  /** Where this root came from. */
  source: 'config' | 'workspace' | 'session' | 'process'
}

/** The payload `GIT_ROOTS_PATH` answers with. */
export interface RootsPayload {
  /** Every root the panel may pick. */
  roots: RepoRoot[]
  /** The root the host would use when a request names none. */
  default: string
  /** What this deployment lets the panel do. */
  capabilities: Capabilities
}

/** The payload `GIT_REPOS_PATH` answers with. */
export interface ReposPayload {
  /** The root that was scanned. */
  root: string
  /** Repositories found, with their status. */
  repos: RepoSummary[]
  /** True when the scan stopped at the repository bound. */
  truncated: boolean
  /** Why the list is empty, when that is a refusal rather than an empty tree. */
  message?: string
}

/** The payload `GIT_STATUS_PATH` answers with. */
export interface StatusPayload {
  /** The status, or no repository when the read failed. */
  status?: RepoStatus
  /** Why the read failed, when it did. */
  message?: string
}

/** The payload `GIT_DIFF_PATH` answers with. */
export interface DiffAnswer {
  /** The diff, or none when the read failed. */
  diff?: DiffPayload
  /** Why the read failed, when it did. */
  message?: string
}

/** Authenticated route that reads one repository's history. */
export const GIT_LOG_PATH = '/api/dsh-git/log'

/** Authenticated route that creates one commit. */
export const GIT_COMMIT_PATH = '/api/dsh-git/commit'

/** Authenticated route that stages, unstages, or discards paths. */
export const GIT_STAGE_PATH = '/api/dsh-git/stage'

/** What one deployment lets the panel do, so it never offers a refused action. */
export interface Capabilities {
  /** Whether staging is allowed. */
  stage: boolean
  /** Whether committing is allowed. */
  commit: boolean
  /** Whether switching branches is allowed. */
  switch: boolean
}

/** The payload `GIT_LOG_PATH` answers with. */
export interface LogPayload {
  /** The repository the history belongs to. */
  repo?: RepoSummary
  /** Commits, newest first, with the parents a graph is drawn from. */
  commits: CommitSummary[]
  /** Why the history could not be read, when it could not. */
  message?: string
}

/** The body `GIT_COMMIT_PATH` accepts. */
export interface CommitRequest {
  /** The repository, by path or name. */
  repo: string
  /** The commit message, used as the whole message. */
  message: string
  /** Stage every tracked change first. */
  all?: boolean
}

/** The payload `GIT_COMMIT_PATH` answers with. */
export interface CommitAnswer {
  /** The status the commit left behind. */
  status?: RepoStatus
  /** The commit that was created. */
  commit?: CommitSummary
  /** Paths the commit changed. */
  files?: DiffFile[]
  /** Why the commit was refused, when it was. */
  message?: string
}

/** The body `GIT_STAGE_PATH` accepts. */
export interface StageRequest {
  /** The repository, by path or name. */
  repo: string
  /** What to do. */
  mode: 'stage' | 'unstage' | 'discard'
  /** Paths, relative to the repository root. */
  paths?: string[]
  /** Apply to every path. */
  all?: boolean
}

/** The payload `GIT_STAGE_PATH` answers with. */
export interface StageAnswer {
  /** The status the change left behind. */
  status?: RepoStatus
  /** Why the operation was refused, when it was. */
  message?: string
}

/** What one repository is called and where it lives. */
export interface RepoIdentity {
  /** Absolute worktree path, or the git directory for a bare repository. */
  worktree: string
  /** Absolute git directory. */
  gitDir: string
  /** True for a bare repository, which has no worktree. */
  bare: boolean
  /** The directory's own name. */
  name: string
}

/** Limits one command runs under. */
export interface GitLimits {
  /** The git executable to run. */
  command: string
  /** Milliseconds one command may take before it is killed. */
  timeoutMs: number
  /** Bytes of one stream that are kept; the rest is dropped and reported. */
  maxOutputBytes: number
}
