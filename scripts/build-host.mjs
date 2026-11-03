/**
 * Build the Node half into the ES module the harness loader imports from an
 * installed package.
 *
 * Harness packages stay external — the deployment resolves them from its own
 * install — and everything of our own is inlined, so the artifact carries no
 * relative `.ts` import that a deployed `dsh` would not load.
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/index.ts' },
  outdir: 'lib',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // The harness resolves these from its own install; nothing else may be
  // inlined into a host half.
  external: ['@deepseek-ai/*'],
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
})
