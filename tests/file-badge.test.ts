/**
 * File-row badge checks: how one path becomes a type badge, a name, and a
 * directory.
 *
 * The mapping is the part a reader notices immediately — `TS` on a TypeScript
 * file, `#` on a stylesheet — and it must not depend on the platform's path
 * separators, because git reports one spelling and a caller may hand over the
 * other.
 *
 *   npm test
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileBadge, splitPath } from '../src/client/file-badge.ts'

test('a path splits into its name and the directory above it', () => {
  assert.deepEqual(splitPath('src/client/GitPanel.tsx'), { directory: 'src/client', name: 'GitPanel.tsx' })
  assert.deepEqual(splitPath('README.md'), { directory: '', name: 'README.md' })
  assert.deepEqual(splitPath('a/b/c.txt'), { directory: 'a/b', name: 'c.txt' })
  assert.deepEqual(splitPath('src\\client\\x.ts'), { directory: 'src\\client', name: 'x.ts' }, 'a joined Windows path is split too')
  assert.deepEqual(splitPath(''), { directory: '', name: '' })
})

test('a known extension gets its badge and its colour family', () => {
  assert.deepEqual(fileBadge('src/a.ts'), { label: 'TS', tone: 'ts' })
  assert.deepEqual(fileBadge('src/a.tsx'), { label: 'TSX', tone: 'tsx' })
  assert.deepEqual(fileBadge('x.mjs'), { label: 'JS', tone: 'js' })
  assert.deepEqual(fileBadge('panel.module.css'), { label: '#', tone: 'css' })
  assert.deepEqual(fileBadge('README.md'), { label: 'MD', tone: 'md' })
  assert.deepEqual(fileBadge('package.json'), { label: '{}', tone: 'json' })
  assert.deepEqual(fileBadge('ci.yml'), { label: 'YML', tone: 'yaml' })
  assert.deepEqual(fileBadge('logo.png'), { label: 'IMG', tone: 'image' })
  assert.deepEqual(fileBadge('run.ps1'), { label: 'PS', tone: 'shell' })
  assert.deepEqual(fileBadge('SRC/A.TSX'), { label: 'TSX', tone: 'tsx' }, 'an upper-case extension is the same type')
})

test('an unknown type falls back to its initial, and a dotfile keeps its own', () => {
  assert.deepEqual(fileBadge('LICENSE'), { label: 'L', tone: 'other' })
  assert.deepEqual(fileBadge('.gitignore'), { label: 'G', tone: 'other' })
  assert.deepEqual(fileBadge('a.'), { label: 'A', tone: 'other' })
  assert.deepEqual(fileBadge(''), { label: '·', tone: 'other' })
  assert.deepEqual(fileBadge('src/'), { label: '·', tone: 'other' }, 'a trailing separator leaves no name')
})
