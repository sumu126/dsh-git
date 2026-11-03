import { parseBranches } from '../src/parse.ts'
const text = [
    'refs/heads/main\x1fmain\x1f659d5e5\x1forigin/main\x1f[ahead 1, behind 1]\x1f*\x1f2026-11-03T11:34:57+08:00\x1fnote subject\x1e\n',
    'refs/heads/feat/x\x1ffeat/x\x1f9f8e7d6\x1f\x1f\x1f \x1f2026-11-03T11:34:56+08:00\x1fslash branch\x1e\n',
  ].join('')
console.log(JSON.stringify(parseBranches(text), null, 2))

