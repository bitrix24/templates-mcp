import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Pin the parity contract between the HTTP build (file-based discovery via
 * Vite glob under `server/mcp/tools/**`) and the stdio bundle (hand-maintained
 * registry in `mcp-stdio/tools.ts`).
 *
 * Why this exists: the stdio build cannot use the HTTP path's auto-discovery
 * — esbuild has no Vite glob equivalent and Nuxt virtual modules are not
 * reachable from the standalone bundle (see ARCHITECTURE.md hot spot #1).
 * A new tool added under `server/mcp/tools/**` MUST also be appended to the
 * stdio registry, otherwise it is silently invisible in the DXT bundle.
 *
 * Strategy: compare import paths, not in-memory tool objects. Tool files
 * import `defineMcpTool` from `@nuxtjs/mcp-toolkit/server`, whose barrel
 * pulls Nitro virtual modules that cannot be resolved outside a Nuxt build
 * context — so we cannot `import(file)` each tool from a Vitest unit. Path
 * comparison is sufficient: every HTTP tool file must appear (modulo the
 * `~/` alias) as an `import … from '~/server/mcp/tools/…'` line in
 * `mcp-stdio/tools.ts`.
 *
 * Failure mode this catches: developer adds `server/mcp/tools/tasks/get-task.ts`,
 * forgets to update `mcp-stdio/tools.ts`. The DXT bundle would ship without
 * the new tool, symptom surfacing only at runtime when an agent calls it.
 */

const PROJECT_ROOT = resolve(__dirname, '../../..')
const HTTP_TOOLS_DIR = join(PROJECT_ROOT, 'server/mcp/tools')
const STDIO_REGISTRY = join(PROJECT_ROOT, 'mcp-stdio/tools.ts')

async function listHttpToolFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listHttpToolFiles(full)))
    }
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

// Match `import <binding> from '~/server/mcp/tools/<path>'` lines. Optional
// trailing `.ts` or `.js` is normalised away.
const IMPORT_RE = /from\s+['"]~\/server\/mcp\/tools\/([^'"]+?)(?:\.(?:ts|js))?['"]/g

function pathToToolKey(filePath: string): string {
  // `server/mcp/tools/users/current-user.ts` → `users/current-user`
  return relative(HTTP_TOOLS_DIR, filePath).replace(/\.ts$/, '').replace(/\\/g, '/')
}

describe('mcp-stdio tools registry parity with server/mcp/tools/**', () => {
  it('every HTTP tool file is imported by mcp-stdio/tools.ts', async () => {
    const httpFiles = await listHttpToolFiles(HTTP_TOOLS_DIR)
    expect(httpFiles.length, 'HTTP tools directory unexpectedly empty').toBeGreaterThan(0)
    const httpKeys = new Set(httpFiles.map(pathToToolKey))

    const registrySource = await readFile(STDIO_REGISTRY, 'utf8')
    const stdioKeys = new Set<string>()
    for (const m of registrySource.matchAll(IMPORT_RE)) {
      stdioKeys.add(m[1]!)
    }
    expect(stdioKeys.size, 'mcp-stdio/tools.ts has no tool imports — registry empty?').toBeGreaterThan(0)

    const missingFromStdio = [...httpKeys].filter((k) => !stdioKeys.has(k)).sort()
    const extraInStdio = [...stdioKeys].filter((k) => !httpKeys.has(k)).sort()

    expect(
      missingFromStdio,
      'HTTP tools missing from mcp-stdio/tools.ts — add the import and append to the `tools` array',
    ).toEqual([])
    expect(
      extraInStdio,
      'stdio registry references tools that no longer exist under server/mcp/tools/**',
    ).toEqual([])
  })

  it('every imported binding in mcp-stdio/tools.ts is also included in the exported `tools` array', async () => {
    // A second failure mode: developer adds the import line but forgets to
    // append the binding to the `tools` array. The bundle compiles, the
    // import resolves, but the tool never reaches McpServer.registerTool.
    const registrySource = await readFile(STDIO_REGISTRY, 'utf8')
    const imports: string[] = []
    for (const m of registrySource.matchAll(/^import\s+(\w+)\s+from\s+['"]~\/server\/mcp\/tools\//gm)) {
      imports.push(m[1]!)
    }
    const toolsArrayMatch = registrySource.match(/export const tools\s*=\s*\[([\s\S]*?)\]\s*as const/)
    expect(toolsArrayMatch, '`export const tools = [...] as const` not found in mcp-stdio/tools.ts').toBeTruthy()
    const arrayBody = toolsArrayMatch![1]!
    const arrayMembers = new Set(
      arrayBody
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    const missingFromArray = imports.filter((name) => !arrayMembers.has(name)).sort()
    expect(
      missingFromArray,
      'Imported tool bindings missing from the exported `tools` array',
    ).toEqual([])
  })
})
