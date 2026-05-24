import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Enforce the `b24_<domain>(_<entity>)*_<action>` naming convention adopted
 * in issue #129. The convention is **singular everywhere** (including before
 * `_list`: `b24_task_list`, `b24_task_result_list`, `b24_task_checklist_item_list`).
 * One rule, no exceptions, no irregular-plural traps (`children`, `people`).
 *
 *   - Bitrix24-talking tools (live under `server/mcp/tools/**` outside `meta/`):
 *       `^b24(_[a-z][a-z0-9]*){2,}$` — `b24` + at least domain + action,
 *       all tokens lowercase, no plurals.
 *   - Meta tools (live under `server/mcp/tools/meta/`, NEVER call Bitrix24):
 *       `^bx24mcp(_[a-z][a-z0-9]*)+$`. The `bx24mcp_` prefix is the
 *       operator-visible signal that the tool stays inside the MCP server
 *       and no portal data leaves.
 *
 * Identity shape `b24_<domain>_me` (currently only `b24_user_me`) is allowed
 * as a special case: the trailing `me` covers both entity (the caller) and
 * action ("identify me"). The b24 regex accepts it without special-casing.
 *
 * The singular-everywhere check uses a small allowlist for words that
 * legitimately end in `s` while being singular (`status`, `address`, `news`,
 * `progress`, `business`). Add to `SINGULAR_S_WHITELIST` when a real case
 * appears — don't fall back to a permissive heuristic.
 *
 * Failure modes this guard catches:
 *   - `bitrix24_foo` or `Bitrix24_Foo` (wrong prefix / casing)
 *   - `b24_tasks_create` (plural middle token — pre-#129 mistake)
 *   - `b24_task_results_list` (plural before `_list` — the issue #129 spec
 *     specifically rejected this in favour of singular)
 *   - a tool file in `meta/` named `b24_*`, or anywhere else named `bx24mcp_*`
 *   - a tool file with no string-literal `name:` field at all
 */

const PROJECT_ROOT = resolve(__dirname, '../../..')
const HTTP_TOOLS_DIR = join(PROJECT_ROOT, 'server/mcp/tools')

const B24_NAME_RE = /^b24(_[a-z][a-z0-9]*){2,}$/
const META_NAME_RE = /^bx24mcp(_[a-z][a-z0-9]*)+$/

// Singular nouns that happen to end in `s`. Extend deliberately when a tool
// genuinely needs one — keep the list short so the singular-everywhere rule
// stays meaningful.
const SINGULAR_S_WHITELIST = new Set<string>([
  'status',
  'address',
  'news',
  'progress',
  'business',
])

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

// Match the `name:` field of the tool definition call specifically, not any
// random `name:` literal that might appear in a nested Zod schema or JSDoc
// comment block. Anchored to either `defineMcpTool(` (direct shape) or any
// `defineXxxTool(` factory wrapper (e.g. `defineTaskLifecycleTool`,
// `defineChecklistTool`, `defineDependencyTool` — the single-or-batch
// scaffolds in `server/utils/`). Future factory wrappers fitting the
// `define*Tool` convention are automatically covered.
const TOOL_NAME_RE = /define[A-Z]\w*Tool(?:\s*<[^>]*>)?\s*\(\s*\{[\s\S]*?\bname:\s*['"]([^'"]+)['"]/

async function extractToolName(filePath: string): Promise<string | null> {
  const src = await readFile(filePath, 'utf8')
  const m = src.match(TOOL_NAME_RE)
  return m?.[1] ?? null
}

function isMetaPath(filePath: string): boolean {
  return relative(HTTP_TOOLS_DIR, filePath).startsWith('meta/')
}

describe('tool naming convention (issue #129)', () => {
  it('every tool file declares a string-literal name inside defineMcpTool({ ... })', async () => {
    const files = await listHttpToolFiles(HTTP_TOOLS_DIR)
    expect(files.length, 'HTTP tools directory unexpectedly empty').toBeGreaterThan(0)

    const missing: string[] = []
    for (const file of files) {
      const name = await extractToolName(file)
      if (!name) missing.push(relative(PROJECT_ROOT, file))
    }
    expect(
      missing,
      'These tool files have no string-literal `name:` field inside their `defineMcpTool({ ... })` call. The naming guard cannot validate them.',
    ).toEqual([])
  })

  it('every tool name matches its directory: b24_* outside meta/, bx24mcp_* inside meta/', async () => {
    const files = await listHttpToolFiles(HTTP_TOOLS_DIR)
    const violations: { file: string, name: string, expected: string }[] = []
    for (const file of files) {
      const name = await extractToolName(file)
      if (!name) continue
      const meta = isMetaPath(file)
      const re = meta ? META_NAME_RE : B24_NAME_RE
      const expected = meta ? 'bx24mcp_<verb>' : 'b24_<domain>(_<entity>)*_<action>'
      if (!re.test(name)) {
        violations.push({ file: relative(PROJECT_ROOT, file), name, expected })
      }
    }

    expect(
      violations,
      'Tool name(s) do not match the convention. Bitrix24 tools: b24_<domain>(_<entity>)*_<action>, singular everywhere. Meta tools: bx24mcp_<verb>. See skills/manage-bx24-template-mcp/adding-tools.md.',
    ).toEqual([])
  })

  it('every tool name uses singular tokens everywhere (no `s`-suffix without whitelist)', async () => {
    // The hardest mistake to catch by eye is a stray plural — `b24_tasks_list`,
    // `b24_task_results_list`. Walk every middle token of every tool name and
    // reject `*s` unless it's in the small singular-on-s allowlist.
    const files = await listHttpToolFiles(HTTP_TOOLS_DIR)
    const violations: { file: string, name: string, badToken: string }[] = []
    for (const file of files) {
      const name = await extractToolName(file)
      if (!name) continue
      const tokens = name.split('_')
      // Skip the first token (`b24` / `bx24mcp` — neither ends in `s`).
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]!
        if (t.endsWith('s') && !SINGULAR_S_WHITELIST.has(t)) {
          violations.push({ file: relative(PROJECT_ROOT, file), name, badToken: t })
          break
        }
      }
    }

    expect(
      violations,
      `Plural token(s) detected. Convention is singular everywhere — including before \`_list\`. If a token is a singular noun that legitimately ends in \`s\` (e.g. \`status\`), add it to SINGULAR_S_WHITELIST in this file.`,
    ).toEqual([])
  })

  it('regexes cross-reject the other family (defence in depth against directory mistakes)', () => {
    // A tool file misplaced under `meta/` with a `b24_*` name (or vice-versa)
    // is caught by the per-directory check above, but only because the regex
    // for the wrong family rejects the name. Pin that contract here so a
    // future loosening of either regex can't silently re-enable the bug.
    expect(B24_NAME_RE.test('bx24mcp_submit_feedback'), 'B24 regex must reject bx24mcp_ prefix').toBe(false)
    expect(META_NAME_RE.test('b24_user_me'), 'META regex must reject b24_ prefix').toBe(false)
    expect(B24_NAME_RE.test('bitrix24_create_task'), 'B24 regex must reject legacy bitrix24_ prefix').toBe(false)
    expect(META_NAME_RE.test('bitrix24_create_task'), 'META regex must reject legacy bitrix24_ prefix').toBe(false)

    // And the positive contract for two canonical names — if either of these
    // ever fails, the regex was loosened too far or tightened too far.
    expect(B24_NAME_RE.test('b24_task_create')).toBe(true)
    expect(B24_NAME_RE.test('b24_user_me')).toBe(true)
    expect(B24_NAME_RE.test('b24_task_checklist_item_add')).toBe(true)
    expect(META_NAME_RE.test('bx24mcp_submit_feedback')).toBe(true)
  })
})
