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
import { validateManifest } from '@anthropic-ai/mcpb'
import { ZipArchive } from 'archiver'
import { build } from 'esbuild'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const manifestOut = join(outDir, 'manifest.json')
await writeFile(manifestOut, JSON.stringify(manifest, null, 2), 'utf8')

// The MCPB validator resolves `manifest.icon` relative to the manifest's
// directory, so the file must exist before `validateManifest` runs. Copy it
// in alongside the manifest, then validate, then bundle the rest.
await cp(resolve(__dirname, 'icon.png'), join(outDir, 'icon.png'))

// Validate against the official DXT/MCPB schema before bundling. Claude
// Desktop runs the same check at install time and refuses the whole package
// on any unrecognised key (e.g. an `options` enum on a user_config field),
// so a build that skips this ships a bundle that fails for every operator.
console.error('[dxt] validating manifest against the MCPB schema')
if (!validateManifest(manifestOut)) {
  throw new Error('manifest.json failed MCPB schema validation — see the errors above')
}

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
  // NOTE (#247): OAuth credentials are NOT baked into the bundle. They
  // flow from Claude Desktop's `user_config` (`bitrix24_oauth_client_id` /
  // `_client_secret`) into env vars at runtime via the manifest's
  // `server.mcp_config.env` mapping. The bundle reads them in
  // `mcp-stdio/nuxt-shims.ts`. One bundle works for all use cases:
  //   - webhook-only: leave the OAuth fields empty in Claude Desktop UI.
  //   - OAuth: register a Bitrix24 Marketplace application (type "without
  //     redirect_uri"), paste CLIENT_ID + CLIENT_SECRET into the bundle's
  //     `user_config` fields. The secret stays in the OS keychain (macOS
  //     Keychain / Windows DPAPI / Linux libsecret subject to availability
  //     — on a headless Linux without GNOME Keyring / KWallet, Claude
  //     Desktop may fall back to plaintext storage) via Claude Desktop's
  //     `sensitive: true` storage; rotation = paste new value, restart.
  //
  // No upstream repo secrets needed for `pnpm build:dxt`. Forks no longer
  // pre-bake their own OAuth credentials; they ship the same upstream
  // bundle and document how operators register their Marketplace app.
  //
  // BACK-COMPAT NOTE for fork developers: the old build-time env vars
  // `BITRIX24_DXT_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` no longer affect
  // the bundle — `define` is gone here. They are retained as RUNTIME
  // un-prefixed fallbacks in `nuxt-shims.ts` (so `export
  // BITRIX24_DXT_OAUTH_CLIENT_ID=… node dist/dxt/server/index.mjs` still
  // works for local smoke testing), but setting them before `pnpm
  // build:dxt` has no effect on the resulting `.dxt`.
  //
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

// Zip via the `archiver` npm package rather than shelling out to the system
// `zip` binary. The npm path is platform-portable (Windows dev machines
// don't ship `zip`), avoids a PATH-hijack vector at build time, and surfaces
// errors with actionable stack traces instead of bare exit codes.
/**
 * @param {string} srcDir
 * @param {string} outPath
 * @returns {Promise<void>}
 */
function zipDirectory(srcDir, outPath) {
  return new Promise((resolveZip, rejectZip) => {
    const output = createWriteStream(outPath)
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.on('close', () => resolveZip())
    output.on('error', rejectZip)
    archive.on('error', rejectZip)
    archive.pipe(output)
    archive.directory(srcDir, false)
    archive.finalize()
  })
}
