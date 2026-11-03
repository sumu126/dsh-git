/**
 * The copy this plugin's panel and tool rows show.
 *
 * Every string a person reads comes from here, in both languages; the component
 * never writes a sentence. Keys are the same in both dictionaries, which is what
 * the client check asserts.
 *
 * @module dsh-git/src/client/locales
 */

/** Namespace of the panel's copy. */
export const NS = 'panel.git'

/** Namespace of the tool rows' copy. */
export const TOOL_NS = 'tool.git'

/** The panel's dictionary, in Chinese. */
export const zh = {
  panelTitle: 'Git',
  guideHint: '查看本工作区内的仓库、状态与改动',
  root: '根目录',
  refresh: '刷新',
  noRoots: '没有可用的仓库根目录。用插件配置里的 root 指定一个，或在一个工作区里打开会话。',
  noRepos: '这个根目录下没有找到 git 仓库。',
  selectHint: '选择一个仓库查看它的状态。',
  loading: '正在读取…',
  failed: '读取失败：{message}',
  retry: '重试',
  clean: '干净',
  staged: '已暂存',
  unstaged: '未暂存',
  untracked: '未跟踪',
  conflicted: '冲突',
  files: '{count} 个改动',
  diff: '差异',
  scopeWorking: '工作区',
  scopeStaged: '已暂存',
  noChanges: '这次比较没有改动。',
  detached: '游离 HEAD',
  ahead: '领先 {count}',
  behind: '落后 {count}',
  cut: '已截断',
  patchCut: '补丁在 {bytes} 字节处截断',
  repository: '仓库',
  branch: '分支',
  changed: '改动',
  emptyRepo: '这个仓库还没有提交。',
  dialogNone: '没有打开的比较',
  filesCut: '只列出了前 {count} 个路径',
} as const

/** The panel's dictionary, in English. */
export const en: Record<keyof typeof zh, string> = {
  panelTitle: 'Git',
  guideHint: 'Repositories in this workspace, with their status and changes',
  root: 'Root',
  refresh: 'Refresh',
  noRoots: 'No repository root is known. Set the plugin\'s root setting, or open a session inside a workspace.',
  noRepos: 'No git repository was found under this root.',
  selectHint: 'Choose a repository to see its status.',
  loading: 'Reading…',
  failed: 'Could not read this root: {message}',
  retry: 'Retry',
  clean: 'clean',
  staged: 'staged',
  unstaged: 'unstaged',
  untracked: 'untracked',
  conflicted: 'conflicted',
  files: '{count} changed',
  diff: 'Diff',
  scopeWorking: 'Working',
  scopeStaged: 'Staged',
  noChanges: 'Nothing changed in this comparison.',
  detached: 'detached',
  ahead: 'ahead {count}',
  behind: 'behind {count}',
  cut: 'cut',
  patchCut: 'patch cut at {bytes} bytes',
  repository: 'Repository',
  branch: 'Branch',
  changed: 'Changed',
  emptyRepo: 'This repository has no commits yet.',
  dialogNone: 'No comparison is open',
  filesCut: 'Only the first {count} paths are listed',
}

/** Every key the panel's dictionaries define. */
export type GitLocaleKey = keyof typeof zh

/** The tool rows' dictionary, in Chinese. */
export const toolZh = {
  statusTitle: '状态',
  logTitle: '提交',
  diffTitle: '差异',
  commitTitle: '提交结果',
  reposTitle: '仓库',
  branchesTitle: '分支',
  remotesTitle: '远程',
  actionTitle: '工作区',
  files: '{count} 个路径',
  noFiles: '没有改动的路径',
  cut: '已截断',
  running: '执行中…',
  failed: '失败',
  repos: '{count} 个仓库',
  additions: '+{count}',
  deletions: '−{count}',
  current: '当前',
  gone: '上游已删除',
  staged: '已暂存',
  unstaged: '未暂存',
  untracked: '未跟踪',
  conflicted: '冲突',
} as const

/** The tool rows' dictionary, in English. */
export const toolEn: Record<keyof typeof toolZh, string> = {
  statusTitle: 'Status',
  logTitle: 'Commits',
  diffTitle: 'Diff',
  commitTitle: 'Committed',
  reposTitle: 'Repositories',
  branchesTitle: 'Branches',
  remotesTitle: 'Remotes',
  actionTitle: 'Working tree',
  files: '{count} path(s)',
  noFiles: 'No changed paths',
  cut: 'cut',
  running: 'running…',
  failed: 'failed',
  repos: '{count} repositories',
  additions: '+{count}',
  deletions: '−{count}',
  current: 'current',
  gone: 'upstream gone',
  staged: 'staged',
  unstaged: 'unstaged',
  untracked: 'untracked',
  conflicted: 'conflicted',
}

/** Every key the tool rows' dictionaries define. */
export type ToolLocaleKey = keyof typeof toolZh
