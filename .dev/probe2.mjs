/**
 * Throwaway probe 2: the unmerged (`u`) status entry, and the exact separator
 * bytes of the log / for-each-ref formats. Probe 1 crashed before the conflict.
 *
 *   node .dev/probe2.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-git-probe2-'))

function git(cwd, args, { input } = {}) {
  const result = spawnSync('git', ['-c', 'user.name=Probe', '-c', 'user.email=probe@example.com', '-c', 'core.quotePath=false', ...args], {
    cwd, encoding: 'utf8', input,
  })
  return { out: result.stdout, err: result.stderr, code: result.status }
}

/** Print stdout with every control byte visible. */
function show(label, text) {
  const visible = [...text].map((char) => {
    const code = char.codePointAt(0)
    if (code === 0) return '\\0'
    if (code === 9) return '\\t'
    if (code === 10) return '\\n'
    if (code === 13) return '\\r'
    if (code < 32) return `\\x${code.toString(16).padStart(2, '0')}`
    return char
  }).join('')
  console.log(`\n=== ${label} ===`)
  console.log(visible)
}

const work = join(root, 'work')
mkdirSync(work, { recursive: true })
git(work, ['init', '-q', '--initial-branch=main'])
writeFileSync(join(work, 'conflict.txt'), 'base\n')
git(work, ['add', '.'])
git(work, ['commit', '-q', '-m', 'base'])
git(work, ['checkout', '-q', '-b', 'side'])
writeFileSync(join(work, 'conflict.txt'), 'side\n')
git(work, ['commit', '-q', '-am', 'side change'])
git(work, ['checkout', '-q', 'main'])
writeFileSync(join(work, 'conflict.txt'), 'main\n')
git(work, ['commit', '-q', '-am', 'main change'])
const merged = git(work, ['merge', 'side'])
console.log(`merge exit: ${merged.code}`)

show('status --porcelain=v2 --branch (conflict)', git(work, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']).out)
show('status --porcelain=v2 -z (conflict)', git(work, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']).out)
show('diff --name-status (conflict)', git(work, ['diff', '--name-status']).out)
show('ls-files -u', git(work, ['ls-files', '-u']).out)

// Separators: a second commit with refs, so both fields and records show up.
writeFileSync(join(work, 'note.txt'), 'note\n')
git(work, ['add', '.'])
git(work, ['commit', '-q', '-m', 'note subject'])
show('log format', git(work, ['log', '--max-count=3', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%at%x1f%s%x1f%D%x1e']).out)
show('for-each-ref', git(work, [
  'for-each-ref',
  '--format=%(refname:short)%1f%(objectname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(committerdate:iso-strict)%1f%(subject)%1e',
  'refs/heads', 'refs/remotes',
]).out)
show('branch upstream track gone', git(work, ['for-each-ref', '--format=%(refname:short)%1f%(upstream:track)%1e', 'refs/heads']).out)
show('diff shortstat empty', git(work, ['diff', '--shortstat']).out)
show('rev-parse short head', git(work, ['rev-parse', '--short', 'HEAD']).out)
show('show -s format', git(work, ['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%at%x1f%s%x1f%D%x1f%P%x1e', 'HEAD']).out)
show('diff-tree name-status', git(work, ['diff-tree', '--no-commit-id', '--name-status', '-r', '-M', 'HEAD']).out)

console.log(`\nprobe root: ${root}`)
rmSync(root, { recursive: true, force: true })
