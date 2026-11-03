import { registerHooks } from 'node:module'
import { load, resolve } from '../scripts/css-stub.mjs'
registerHooks({ resolve, load })
const { GitIcon } = await import('../src/client/GitPanel.tsx')
const el = GitIcon({ size: 16 })
console.log('typeof', typeof el)
console.log('keys', Object.keys(el))
console.log('type', el.type, typeof el.type)
console.log('react version', (await import('react')).version)
