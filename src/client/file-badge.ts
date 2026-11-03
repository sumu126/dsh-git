/**
 * How one path is drawn in a file row: a type badge, the file's own name, and the
 * directory it sits in.
 *
 * A log view lists hundreds of paths; the reader scans the file name and only
 * then asks where it lives, so the two are split here and laid out as name first,
 * directory second. Pure by construction, so the mapping is unit-tested rather
 * than eyeballed.
 *
 * @module dsh-git/src/client/file-badge
 */

/** The badge family a path's type belongs to, for colouring. */
export type FileTone = 'ts' | 'tsx' | 'js' | 'css' | 'md' | 'json' | 'yaml' | 'image' | 'shell' | 'other'

/** What one row shows for a path. */
export interface FileBadge {
  /** The short label in the badge, such as `TS` or `#`. */
  label: string
  /** Which colour family it belongs to. */
  tone: FileTone
}

/** The badge and tone for each extension this plugin recognises. */
const BY_EXTENSION: Readonly<Record<string, FileBadge>> = {
  ts: { label: 'TS', tone: 'ts' },
  mts: { label: 'TS', tone: 'ts' },
  cts: { label: 'TS', tone: 'ts' },
  tsx: { label: 'TSX', tone: 'tsx' },
  js: { label: 'JS', tone: 'js' },
  mjs: { label: 'JS', tone: 'js' },
  cjs: { label: 'JS', tone: 'js' },
  jsx: { label: 'JSX', tone: 'tsx' },
  css: { label: '#', tone: 'css' },
  scss: { label: '#', tone: 'css' },
  less: { label: '#', tone: 'css' },
  md: { label: 'MD', tone: 'md' },
  mdx: { label: 'MD', tone: 'md' },
  json: { label: '{}', tone: 'json' },
  jsonc: { label: '{}', tone: 'json' },
  yml: { label: 'YML', tone: 'yaml' },
  yaml: { label: 'YML', tone: 'yaml' },
  png: { label: 'IMG', tone: 'image' },
  jpg: { label: 'IMG', tone: 'image' },
  jpeg: { label: 'IMG', tone: 'image' },
  gif: { label: 'IMG', tone: 'image' },
  webp: { label: 'IMG', tone: 'image' },
  svg: { label: 'SVG', tone: 'image' },
  ico: { label: 'ICO', tone: 'image' },
  sh: { label: 'SH', tone: 'shell' },
  ps1: { label: 'PS', tone: 'shell' },
  bat: { label: 'BAT', tone: 'shell' },
  cmd: { label: 'BAT', tone: 'shell' },
}

/**
 * Split a path into the file's own name and the directory before it.
 *
 * git reports forward slashes on every platform; a backslash is accepted too so a
 * caller that joined a Windows path does not end up with the whole path as the
 * name.
 * @param path - the path as git reported it.
 * @returns the directory (empty at the root) and the file name.
 */
export function splitPath(path: string): { directory: string, name: string } {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return { directory: '', name: path }
  return { directory: path.slice(0, cut), name: path.slice(cut + 1) }
}

/**
 * The badge one path draws.
 * @param path - the path as git reported it.
 * @returns the label and colour family; an unknown type gets its first letter.
 */
export function fileBadge(path: string): FileBadge {
  const { name } = splitPath(path)
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
  const known = BY_EXTENSION[extension]
  if (known !== undefined) return known
  // A dotfile has no extension to speak of: `.gitignore` is "G", not "".
  const initial = (name.startsWith('.') ? name.slice(1) : name).charAt(0).toUpperCase()
  return { label: initial.length === 0 ? '·' : initial, tone: 'other' }
}
