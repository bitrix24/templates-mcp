#!/usr/bin/env node
/**
 * Build the local-stdio DXT artifact.
 *
 * Steps:
 *   1. Bundle `mcp-stdio/server.ts` (and its transitive imports of the same
 *      tool files the HTTP server uses) into a single self-contained
 *      `dist/dxt/server/index.mjs` via esbuild. The Nuxt `~` alias is
 *      mapped to the project root so existing tool files compile unchanged.
 *      Native deps (the SDK, b24jssdk, zod, mcp-toolkit) are bundled too —
 *      DXT runtime only ships a Node binary, no node_modules.
 *   2. Copy `manifest.json` to `dist/dxt/manifest.json`.
 *   3. Zip the directory as `dist/bx24-template-mcp.dxt`. `.dxt` is just a
 *      `.zip` with a fixed extension.
 *
 * Run via `pnpm build:dxt`.
 */
import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const outDir = resolve(projectRoot, 'dist/dxt')
const dxtPath = resolve(projectRoot, 'dist/bx24-template-mcp.dxt')

await rm(outDir, { recursive: true, force: true })
await rm(dxtPath, { force: true })
await mkdir(join(outDir, 'server'), { recursive: true })

const manifest = JSON.parse(
  await readFile(resolve(__dirname, 'manifest.json'), 'utf8'),
)
const pkg = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'))
manifest.version = pkg.version
await writeFile(
  join(outDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8',
)

console.error(`[dxt] bundling server.ts → ${outDir}/server/index.mjs`)
await build({
  entryPoints: [resolve(__dirname, 'server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(outDir, 'server/index.mjs'),
  // The Nuxt `~` alias resolves to the project root. Tool files import via
  // `~/server/utils/*` and `~/server/mcp/tools/*` — same as in the HTTP build.
  alias: {
    '~': projectRoot,
    // Re-route the toolkit barrel to a local shim — its `index.js` re-exports
    // Nitro-bound `cache.js` and Nuxt-virtual `listings.js`, neither of which
    // is reachable outside a Nuxt build context. The shim provides only the
    // one symbol tool files actually consume.
    '@nuxtjs/mcp-toolkit/server': resolve(__dirname, 'toolkit-shim.ts'),
  },
  // Banner: ESM-compatible shims for __dirname / require if any transitive
  // dep needs them. Keeps Node 22 happy without CommonJS interop surprises.
  banner: {
    js:
      'import { createRequire as __cr } from "module";'
      + 'const require = __cr(import.meta.url);',
  },
  // The DXT manifest declares `node ${__dirname}/server/index.mjs`; nothing
  // is loaded out-of-band, so everything must be inlined.
  external: [],
  minify: false,
  sourcemap: false,
  // Zod 4 + MCP SDK 1.29 interact badly under aggressive tree-shaking:
  // SDK's `types.js` evaluates `z.custom(...)` at top level, and esbuild's
  // lazy-init wrapping of Zod's `sideEffects:false` modules can leave
  // `ZodCustom` undefined at that moment (TypeError: Class2 is not a
  // constructor). Disabling tree-shaking forces every wrapper to run on
  // module load, restoring the order zod expects.
  treeShaking: false,
  keepNames: true,
  logLevel: 'info',
})

console.error('[dxt] copying README/LICENSE')
await cp(resolve(projectRoot, 'LICENSE'), join(outDir, 'LICENSE'))
await cp(resolve(__dirname, 'README.md'), join(outDir, 'README.md'))

console.error(`[dxt] zipping → ${dxtPath}`)
await zipDirectory(outDir, dxtPath)

console.error('[dxt] done')

// Uses the system `zip` binary — universal on macOS/Linux runners, avoids
// pulling a Node zip lib for one step. CI (ubuntu-latest, macos-latest)
// ships `zip` by default.
function zipDirectory(srcDir, outPath) {
  return new Promise((resolveZip, rejectZip) => {
    const child = spawn('zip', ['-rq', outPath, '.'], {
      cwd: srcDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('error', rejectZip)
    child.on('exit', (code) => {
      if (code === 0) resolveZip()
      else rejectZip(new Error(`zip exited with code ${code}`))
    })
  })
}
