/**
 * Throwaway probe: print the exact byte-level output of the git plumbing
 * commands this plugin parses, on a throwaway repository that exercises the
 * awkward cases (rename, conflict, unicode path, path with spaces, ahead/behind
 * against a real upstream).
 *
 *   node .dev/probe.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-git-probe-'))

/** Run git with a fixed identity and no user configuration. */
function git(cwd, args, { input } = {}) {
  const result = spawnSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', '-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    input,
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  return result.stdout
}

/** Print one command's stdout with escapes visible. */
function show(label, text) {
  const visible = text.replace(/\0/g, '\\0').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
  console.log(`\n=== ${label} ===`)
  console.log(visible)
}

const work = join(root, 'work')
const origin = join(root, 'origin.git')
mkdirSync(work, { recursive: true })
git(root, ['init', '-q', '--bare', '--initial-branch=main', origin])
git(work, ['init', '-q', '--initial-branch=main'])

writeFileSync(join(work, 'alpha.txt'), 'one\n')
writeFileSync(join(work, '中文 name.txt'), 'unicode\n')
writeFileSync(join(work, 'rename-me.txt'), 'rename\n')
git(work, ['add', '.'])
git(work, ['commit', '-q', '-m', 'initial commit'])

// A real upstream, then one local commit and one remote commit → diverged.
git(work, ['remote', 'add', 'origin', origin])
git(work, ['push', '-q', '-u', 'origin', 'main'])

writeFileSync(join(work, 'alpha.txt'), 'one\ntwo\n')
git(work, ['commit', '-q', '-am', 'local ahead'])

// A staged rename, an unstaged modification, untracked files, and a conflict.
git(work, ['mv', 'rename-me.txt', 'renamed file.txt'])
writeFileSync(join(work, '中文 name.txt'), 'unicode changed\n')
writeFileSync(join(work, 'untracked file.txt'), 'new\n')
writeFileSync(join(work, 'brand new.txt'), 'new\n')

show('status --porcelain=v2 --branch (before conflict)', git(work, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']))

// Diverged upstream: make a commit on the bare remote's side.
const other = join(root, 'other')
mkdirSync(other, { recursive: true })
git(root, ['clone', '-q', origin, other])
writeFileSync(join(other, 'remote.txt'), 'from remote\n')
git(other, ['add', '.'])
git(other, ['commit', '-q', '-m', 'remote commit'])
git(other, ['push', '-q'])
git(work, ['fetch', '-q', 'origin'])

show('status --porcelain=v2 --branch (diverged)', git(work, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']))
show('status --porcelain=v2 -z', git(work, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']))

show('log format', git(work, ['log', '--max-count=5', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%at%x1f%s%x1f%D%x1e']))

show('for-each-ref format', git(work, [
  'for-each-ref',
  '--format=%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(committerdate:iso-strict)%1f%(subject)%1e',
  'refs/heads',
  'refs/remotes',
]))

show('diff --name-status (staged)', git(work, ['diff', '--cached', '--name-status', '-M']))
show('diff --numstat (staged)', git(work, ['diff', '--cached', '--numstat', '-M']))
show('diff --name-status -z (staged)', git(work, ['diff', '--cached', '--name-status', '-z', '-M']))
show('diff --shortstat (staged)', git(work, ['diff', '--cached', '--shortstat', '-M']))
show('diff patch (staged)', git(work, ['diff', '--cached', '--patch', '--no-color', '-M']))

show('rev-parse identity', git(work, ['rev-parse', '--absolute-git-dir', '--is-bare-repository']))
show('rev-parse toplevel', git(work, ['rev-parse', '--show-toplevel']))

// Conflict: diverge the same file on both sides.
git(work, ['stash', '-q', '-u'])
git(work, ['pull', '-q', '--no-rebase', '--no-edit', 'origin', 'main'])
git(work, ['stash', 'pop', '-q'])
writeFileSync(join(other, 'alpha.txt'), 'remote two\n')
git(other, ['commit', '-q', '-am', 'remote touches alpha'])
git(other, ['push', '-q'])
git(work, ['fetch', '-q', 'origin'])
git(work, ['merge', 'origin/main', '-m', 'merge']).toString?.()
// The merge above may fail, which is the point; ignore its exit status.
spawnSync('git', ['merge', 'origin/main'], { cwd: work, encoding: 'utf8' })
show('status --porcelain=v2 --branch (conflict)', git(work, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']))
show('diff --name-status -z (unmerged)', git(work, ['diff', '--name-status', '-z']))

console.log(`\nprobe root: ${root}`)
rmSync(root, { recursive: true, force: true })
