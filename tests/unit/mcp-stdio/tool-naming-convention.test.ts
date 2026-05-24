import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Enforce the `b24_<domain>(_<entity>)*_<action>` naming convention adopted in
 * issue #129. The convention groups every tool for one entity together when
 * sorted alphabetically (`b24_task_checklist_item_add`, `_complete`, `_delete`,
 * `_renew`, plus plural `_items_list`) and keeps the verb in a predictable
 * trailing slot.
 *
 *   - Bitrix24-talking tools (live under `server/mcp/tools/**`):
 *       `^b24(_[a-z][a-z0-9]*){2,}$` — `b24` + at least domain + action.
 *       Singular entity by default; **plural for the `_list` action**
 *       (`b24_tasks_list`, `b24_task_results_list`, `b24_task_checklist_items_list`).
 *   - Meta tools (do NOT call Bitrix24):
 *       `^bx24mcp(_[a-z][a-z0-9]*)+$` — keeps the older prefix so the
 *       privacy / no-portal-call boundary is visible from the name alone.
 *
 * Failure mode this catches: a contributor adds `server/mcp/tools/tasks/bitrix24_foo.ts`
 * with `name: 'bitrix24_foo'`, or names a list tool `b24_task_result_list` (singular)
 * — both regress the convention. CI fails before the drift compounds.
 */

const PROJECT_ROOT = resolve(__dirname, '../../..')
const HTTP_TOOLS_DIR = join(PROJECT_ROOT, 'server/mcp/tools')

const B24_NAME_RE = /^b24(_[a-z][a-z0-9]*){2,}$/
const META_NAME_RE = /^bx24mcp(_[a-z][a-z0-9]*)+$/

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

const NAME_FIELD_RE = /\bname:\s*['"]([^'"]+)['"]/

async function extractToolName(filePath: string): Promise<string | null> {
  const src = await readFile(filePath, 'utf8')
  const m = src.match(NAME_FIELD_RE)
  return m?.[1] ?? null
}

describe('tool naming convention (issue #129)', () => {
  it('every tool name under server/mcp/tools/** matches b24_<domain>_<...>_<action> or bx24mcp_<verb>', async () => {
    const files = await listHttpToolFiles(HTTP_TOOLS_DIR)
    expect(files.length, 'HTTP tools directory unexpectedly empty').toBeGreaterThan(0)

    const violations: { file: string, name: string | null }[] = []
    for (const file of files) {
      const name = await extractToolName(file)
      // A tool file with no `name:` literal is a contract violation by itself.
      const isMeta = relative(HTTP_TOOLS_DIR, file).startsWith('meta/')
      const re = isMeta ? META_NAME_RE : B24_NAME_RE
      if (!name || !re.test(name)) {
        violations.push({ file: relative(PROJECT_ROOT, file), name })
      }
    }

    expect(
      violations,
      'Tool name(s) do not match the convention. Bitrix24 tools: b24_<domain>(_<entity>)*_<action>, singular by default, plural for _list. Meta tools: bx24mcp_<verb>. See skills/manage-bx24-template-mcp/adding-tools.md.',
    ).toEqual([])
  })

  it('every list tool uses a plural entity in front of the trailing _list action', async () => {
    // Singular-vs-plural for the _list action is the one exception in the
    // convention (issue #129 decision 2). Catch a future regression where a
    // contributor copies a singular-entity sibling (e.g. `_item_complete`)
    // and accidentally ships `_item_list`.
    const files = await listHttpToolFiles(HTTP_TOOLS_DIR)
    const violations: { file: string, name: string }[] = []
    for (const file of files) {
      const name = await extractToolName(file)
      if (!name || !name.endsWith('_list')) continue
      // Token immediately before `_list` must end in `s` (loose plural test).
      // Single-task `b24_tasks_list` is fine; `b24_task_results_list` is fine;
      // `b24_task_result_list` would fail (singular before `_list`).
      const tokens = name.split('_')
      const entityToken = tokens[tokens.length - 2]!
      if (!entityToken.endsWith('s')) {
        violations.push({ file: relative(PROJECT_ROOT, file), name })
      }
    }

    expect(
      violations,
      'List tools must use a plural entity in front of `_list` (e.g. b24_tasks_list, b24_task_results_list, b24_task_checklist_items_list).',
    ).toEqual([])
  })
})
