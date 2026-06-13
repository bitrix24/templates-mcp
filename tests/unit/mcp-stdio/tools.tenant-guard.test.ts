import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Pin the tenant-dispatcher invariant from `docs/ARCHITECTURE.md` hot spot #2:
 * every tool handler under `server/mcp/tools/**` must reach the Bitrix24 SDK
 * via `useBitrix24Tenant()` from `~/server/utils/bitrix24-tenant`. A direct
 * `useBitrix24()` call (or a literal import of `~/server/utils/bitrix24`) pins
 * the tool to the webhook path forever and silently breaks multi-tenant mode
 * when an operator flips `NUXT_BITRIX24_OAUTH_ENABLED=true`.
 *
 * The naming-convention guard (`tool-naming-convention.test.ts`) catches name
 * drift but says nothing about handler bodies; this test fills the gap that
 * `ADDING-TOOLS.md` and `ARCHITECTURE.md` both explicitly call out.
 *
 * Failure mode this catches: contributor copies a snippet that imports
 * `useBitrix24` directly. Suite turns red on the next CI run, the diff names
 * the offending file, the contributor reads the rule before merge.
 *
 * Scope: only files under `server/mcp/tools/**`. The dispatcher itself
 * (`bitrix24-tenant.ts`) is the legitimate caller of `useBitrix24()` and lives
 * outside this scan. The `meta/` group (today only `bx24mcp_submit_feedback`)
 * doesn't call Bitrix24 at all, so the guard is a no-op there; the test still
 * walks it for forward-compatibility.
 */

const TOOLS_ROOT = resolve(import.meta.dirname, '../../../server/mcp/tools')

async function walkTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await walkTsFiles(full))
    }
    else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('tools.tenant-guard', () => {
  it('every file under server/mcp/tools/** uses useBitrix24Tenant (never the bare webhook accessor)', async () => {
    const files = await walkTsFiles(TOOLS_ROOT)
    expect(files.length).toBeGreaterThan(0)

    const offenders: Array<{ file: string, reason: string }> = []
    // Two patterns to reject:
    //   1) an import line bringing `useBitrix24` (not `useBitrix24Tenant`) in
    //      from anywhere — defence even if the name is renamed at the call site;
    //   2) a `useBitrix24()` invocation in the file body — defence against an
    //      ALS-bypass via a transitive helper or a destructured re-export.
    // The shape `useBitrix24Tenant(` is always allowed.
    const importRe = /\buseBitrix24(?!Tenant)\b/
    const callRe = /\buseBitrix24\s*\(/
    for (const file of files) {
      const src = await readFile(file, 'utf8')
      // Strip the test's own pattern strings from the body so a future
      // tool file containing the literal in a comment doesn't trip the
      // guard. Realistically nobody does this; the strip is defence in
      // depth. The check below uses the original source.
      if (importRe.test(src) && !/import\s+[^;]*useBitrix24Tenant/.test(src)) {
        offenders.push({ file, reason: 'imports useBitrix24 (not useBitrix24Tenant)' })
        continue
      }
      if (callRe.test(src) && !/useBitrix24Tenant\s*\(/.test(src)) {
        offenders.push({ file, reason: 'calls useBitrix24() — must go through useBitrix24Tenant()' })
      }
    }

    if (offenders.length > 0) {
      const lines = offenders.map(o => `  - ${o.file}: ${o.reason}`).join('\n')
      throw new Error(
        `Tools must reach Bitrix24 only via useBitrix24Tenant() — see docs/ARCHITECTURE.md hot spot #2.\n${lines}`,
      )
    }
  })
})
