/**
 * Parser checks: the exact documents git prints, read by the functions that
 * parse them.
 *
 * Every fixture below is a real command's output, captured from git 2.45 on
 * Windows. They are the cases that decide whether the panel and the tools tell
 * the truth: a rename, a conflict, a path with a space, a quoted path, a
 * detached HEAD, a branch whose upstream is gone, and a repository with no
 * commits yet.
 *
 *   npm test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  countStatus, parseBranches, parseLog, parseNameStatus, parseNameStatusZ, parseRemotes,
  parseShortStat, parseStatusV2, parseUpstreamTrack, splitStatusLines, stripEol, unquoteGitPath,
} from '../src/parse.ts'

test('a status entry carries its letters, and a rename carries its old path', () => {
  const parsed = parseStatusV2([
    '# branch.oid 5a59531e23dbdbf6e621aa984658d5836455767c',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +1 -1',
    '2 R. N... 100644 100644 100644 a4ec98f2e280f532fb765337db0876bd6d14586c a4ec98f2e280f532fb765337db0876bd6d14586c R100 renamed file.txt\trename-me.txt',
    '1 .M N... 100644 100644 100644 4de4f936336736200e7a59438ef4d31ed10f684d 4de4f936336736200e7a59438ef4d31ed10f684d 中文 name.txt',
    '? brand new.txt',
    '',
  ].join('\n'))
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.detached, false)
  assert.equal(parsed.head, '5a59531', 'the head is abbreviated, because that is what a card shows')
  assert.equal(parsed.upstream, 'origin/main')
  assert.equal(parsed.ahead, 1)
  assert.equal(parsed.behind, 1)
  assert.deepEqual(parsed.files, [
    { path: 'renamed file.txt', origPath: 'rename-me.txt', index: 'R', worktree: '.', kind: 'renamed' },
    { path: '中文 name.txt', index: '.', worktree: 'M', kind: 'changed' },
    { path: 'brand new.txt', index: '.', worktree: '?', kind: 'untracked' },
  ])
})

test('a conflict is one entry, not two', () => {
  const parsed = parseStatusV2([
    '# branch.oid b0f26bc5c09512b7ce581012cbb32d8999a371c5',
    '# branch.head main',
    'u UU N... 100644 100644 100644 100644 df967b96a579e45a18b8251732d16804b2e56a55 ba2906d0666cf726c7eaadd2cd3db615dedfdf3a 2299c37978265a95cbe835a4b0f0bbf15aad5549 conflict.txt',
  ].join('\n'))
  assert.deepEqual(parsed.files, [
    { path: 'conflict.txt', index: 'U', worktree: 'U', kind: 'unmerged' },
  ])
  assert.equal(parsed.ahead, 0)
  assert.equal(parsed.behind, 0)
  assert.equal(parsed.upstream, null)
})

test('a repository with no commit yet reports an unborn branch and no head', () => {
  const parsed = parseStatusV2([
    '# branch.oid (initial)',
    '# branch.head main',
    '? first.txt',
  ].join('\n'))
  assert.equal(parsed.head, null)
  assert.equal(parsed.branch, 'main')
  assert.equal(parsed.detached, false)
  assert.equal(parsed.files[0]?.kind, 'untracked')
})

test('a detached HEAD has no branch name and says so', () => {
  const parsed = parseStatusV2([
    '# branch.oid 659d5e5f31a8909038c5b1b38832ddc9ea20cedc',
    '# branch.head (detached)',
  ].join('\n'))
  assert.equal(parsed.branch, null)
  assert.equal(parsed.detached, true)
})

test('a quoted path is decoded, so a name with a tab reads as itself', () => {
  const parsed = parseStatusV2([
    '# branch.oid 659d5e5f31a8909038c5b1b38832ddc9ea20cedc',
    '# branch.head main',
    '? "tab\\there.txt"',
  ].join('\n'))
  assert.equal(parsed.files[0]?.path, 'tab\there.txt')
  assert.equal(unquoteGitPath('"quote\\"and\\\\slash.txt"'), 'quote"and\\slash.txt')
  assert.equal(unquoteGitPath('"\\346\\226\\207.txt"'), '文.txt', 'octal escapes spell the UTF-8 bytes')
  assert.equal(unquoteGitPath('plain.txt'), 'plain.txt', 'an unquoted path is left alone')
})

test('the four counts separate staged from unstaged from untracked from conflicted', () => {
  const counts = countStatus([
    // Staged edit, then a further unstaged edit: both counts apply.
    { path: 'both.txt', index: 'M', worktree: 'M', kind: 'changed' },
    { path: 'staged.txt', index: 'A', worktree: '.', kind: 'changed' },
    { path: 'unstaged.txt', index: '.', worktree: 'M', kind: 'changed' },
    { path: 'new.txt', index: '.', worktree: '?', kind: 'untracked' },
    { path: 'clash.txt', index: 'U', worktree: 'U', kind: 'unmerged' },
  ])
  assert.deepEqual(counts, { staged: 2, unstaged: 2, untracked: 1, conflicted: 1 })
})

test('a log record carries its refs and parents, and an empty decoration is no ref', () => {
  const log = parseLog([
    '659d5e5f31a8909038c5b1b38832ddc9ea20cedc\x1f659d5e5\x1fProbe\x1fprobe@example.com\x1f2026-11-03T11:34:57+08:00\x1f1793676897\x1fnote subject\x1fHEAD -> main, origin/main\x1fb0f26bc\x1e\n',
    'b0f26bc5c09512b7ce581012cbb32d8999a371c5\x1fb0f26bc\x1fProbe\x1fprobe@example.com\x1f2026-11-03T11:34:56+08:00\x1f1793676896\x1fmain change\x1f\x1e\n',
  ].join(''), { parents: true })
  assert.equal(log.length, 2)
  assert.equal(log[1]?.hash, 'b0f26bc5c09512b7ce581012cbb32d8999a371c5', 'the record after a separator starts at its own first field')
  assert.deepEqual(log[0]?.refs, ['HEAD -> main', 'origin/main'])
  assert.deepEqual(log[0]?.parents, ['b0f26bc'], 'the parents field is read when asked for')
  assert.deepEqual(log[1]?.refs, [], 'an empty decoration produces no ref')
  assert.equal(log[1]?.subject, 'main change')
  assert.equal(log[0]?.timestamp, 1793676897)
})

test('a branch line says what its upstream track means, including gone', () => {
  const branches = parseBranches([
    'refs/heads/main\x1fmain\x1f659d5e5\x1forigin/main\x1f[ahead 1, behind 1]\x1f*\x1f2026-11-03T11:34:57+08:00\x1fnote subject\x1e\n',
    'refs/heads/side\x1fside\x1f3c3b2be\x1f\x1f\x1f \x1f2026-11-03T11:34:56+08:00\x1fside change\x1e\n',
    'refs/heads/old\x1fold\x1f1a2b3c4\x1forigin/old\x1f[gone]\x1f \x1f2026-11-03T11:34:56+08:00\x1fold branch\x1e\n',
    'refs/remotes/origin/main\x1forigin/main\x1f1e98dcb\x1f\x1f\x1f \x1f2026-11-03T11:34:57+08:00\x1fremote commit\x1e\n',
    'refs/heads/feat/x\x1ffeat/x\x1f9f8e7d6\x1f\x1f\x1f \x1f2026-11-03T11:34:56+08:00\x1fslash branch\x1e\n',
  ].join(''))
  assert.deepEqual(branches.map(branch => branch.name), ['main', 'side', 'old', 'origin/main', 'feat/x'])
  assert.equal(branches[0]?.current, true)
  assert.equal(branches[0]?.track, 'tracked')
  assert.equal(branches[0]?.ahead, 1)
  assert.equal(branches[0]?.behind, 1)
  assert.equal(branches[1]?.track, 'untracked', 'no upstream is untracked, not gone')
  assert.equal(branches[2]?.track, 'gone')
  assert.equal(branches[3]?.local, false, 'a remote-tracking branch is not local')
  assert.equal(branches[4]?.local, true, 'a slash in the branch name does not make it remote')
  assert.equal(branches[4]?.current, false)
})

test('an upstream track reads its two counts', () => {
  assert.deepEqual(parseUpstreamTrack('[ahead 3, behind 2]'), { ahead: 3, behind: 2, gone: false })
  assert.deepEqual(parseUpstreamTrack('[ahead 1]'), { ahead: 1, behind: 0, gone: false })
  assert.deepEqual(parseUpstreamTrack('[behind 4]'), { ahead: 0, behind: 4, gone: false })
  assert.deepEqual(parseUpstreamTrack('[gone]'), { ahead: 0, behind: 0, gone: true })
  assert.deepEqual(parseUpstreamTrack(''), { ahead: 0, behind: 0, gone: false })
})

test('a name-status list reads a rename as its three fields', () => {
  assert.deepEqual(parseNameStatus('R100\trename-me.txt\trenamed file.txt\nM\talpha.txt\nU\tconflict.txt\n'), [
    { status: 'R100', path: 'renamed file.txt', origPath: 'rename-me.txt' },
    { status: 'M', path: 'alpha.txt' },
    { status: 'U', path: 'conflict.txt' },
  ])
})

test('a NUL-terminated name-status list reads renames and ordinary entries alike', () => {
  assert.deepEqual(parseNameStatusZ('R100\0rename-me.txt\0renamed file.txt\0M\0alpha.txt\0'), [
    { status: 'R100', path: 'renamed file.txt', origPath: 'rename-me.txt' },
    { status: 'M', path: 'alpha.txt' },
  ])
  // A path holding a tab is exactly what the NUL form is for.
  assert.deepEqual(parseNameStatusZ('M\0tab\there.txt\0'), [{ status: 'M', path: 'tab\there.txt' }])
})

test('a shortstat line reads its totals, and an empty one reads as nothing', () => {
  assert.deepEqual(parseShortStat(' 1 file changed, 0 insertions(+), 0 deletions(-)\n'), {
    files: 1, additions: 0, deletions: 0,
  })
  assert.deepEqual(parseShortStat(' 3 files changed, 42 insertions(+), 7 deletions(-)\n'), {
    files: 3, additions: 42, deletions: 7,
  })
  assert.deepEqual(parseShortStat(' 1 file changed, 1 insertion(+)\n'), { files: 1, additions: 1, deletions: 0 })
  assert.deepEqual(parseShortStat(''), { files: 0, additions: 0, deletions: 0 })
})

test('remotes pair their fetch and push URLs', () => {
  const remotes = parseRemotes([
    'origin\tgit@github.com:sumu126/dsh-git.git (fetch)',
    'origin\tgit@github.com:sumu126/dsh-git.git (push)',
    'mirror\thttps://example.com/mirror.git (fetch)',
    'mirror\thttps://example.com/push.git\t(push)',
  ].join('\n'))
  assert.equal(remotes.length, 2)
  assert.deepEqual(remotes[0], {
    name: 'origin',
    fetch: 'git@github.com:sumu126/dsh-git.git',
    push: 'git@github.com:sumu126/dsh-git.git',
  })
  assert.deepEqual(remotes[1], {
    name: 'mirror', fetch: 'https://example.com/mirror.git', push: 'https://example.com/push.git',
  })
})

test('the status document splits into headers and entries', () => {
  const split = splitStatusLines('# branch.oid abc\n# branch.head main\n? new.txt\n')
  assert.deepEqual(split.headers, ['# branch.oid abc', '# branch.head main'])
  assert.deepEqual(split.entries, ['? new.txt'])
})

test('one trailing line ending is stripped and no more', () => {
  assert.equal(stripEol('main\n'), 'main')
  assert.equal(stripEol('main\r\n'), 'main')
  assert.equal(stripEol('main'), 'main')
  assert.equal(stripEol('main\n\n'), 'main\n')
})
