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
 * Identity shape `b24_user_me` is the one allowed `_me` form. The trailing
 * `me` covers both entity (the caller) and action ("identify me"). The check
 * is scoped to the `user` domain — `b24_task_me`, `b24_calendar_me`, etc.
 * are explicitly rejected so the `_me` shape doesn't drift onto other
 * entities by accident (e.g. an LLM-suggested rename for "my tasks" tool).
 * Opening up new `_me` shapes requires a deliberate convention update, not
 * a one-off naming choice (see ME_SHAPE_RE / ME_DOMAIN_ALLOWLIST below).
 *
 * The singular-everywhere check uses a small allowlist for words that
 * legitimately end in `s` while being singular (`status`, `address`,
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
 *   - `b24_<not-user>_me` (the `_me` shape escaping the user domain)
 */

const PROJECT_ROOT = resolve(__dirname, '../../..')
const HTTP_TOOLS_DIR = join(PROJECT_ROOT, 'server/mcp/tools')

const B24_NAME_RE = /^b24(_[a-z][a-z0-9]*){2,}$/
const META_NAME_RE = /^bx24mcp(_[a-z][a-z0-9]*)+$/

// `_me` shape: identity tool where the trailing `me` is both entity and
// action. Restricted to a hardcoded domain allowlist so a future tool
// can't slip in as `b24_task_me` / `b24_calendar_me` without an explicit
// convention update.
const ME_SHAPE_RE = /^b24_([a-z][a-z0-9]*)_me$/
const ME_DOMAIN_ALLOWLIST = new Set<string>(['user'])

// Singular nouns that happen to end in `s`. Extend deliberately when a tool
// genuinely needs one — keep the list short so the singular-everywhere rule
// stays meaningful. Don't add words speculatively: the guard's value comes
// from rejecting `*s` by default.
const SINGULAR_S_WHITELIST = new Set<string>([
  'status',
  'address',
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

// Match the `name:` field of the tool definition. The leading `define*Tool`
// anchor avoids matching `name:` literals inside JSDoc, Zod schemas, or
// nested interfaces. We do NOT try to parse the optional generic argument
// list — `[\s\S]*?` reaches the first `name:` either way, which keeps the
// regex shallow and robust against multi-line / nested generics (e.g.
// `defineActionTool<\n  Foo<Bar>,\n  Baz\n>({`).
//
// Limitation (deliberate, not a bug): only string-literal `name: 'b24_...'`
// is recognised. Shorthand `{ name }` or variable references like
// `{ name: TOOL_NAME }` will surface as "no string-literal name" in the
// first `it()` below — the diagnostic is intentional; we want the literal
// in the source so static analysis (this guard, ripgrep, IDE rename) works.
const TOOL_NAME_RE = /define[A-Z]\w*Tool[\s\S]*?\bname:\s*['"]([^'"]+)['"]/

async function extractToolName(filePath: string): Promise<string | null> {
  const src = await readFile(filePath, 'utf8')
  const m = src.match(TOOL_NAME_RE)
  return m?.[1] ?? null
}

function isMetaPath(filePath: string): boolean {
  return relative(HTTP_TOOLS_DIR, filePath).startsWith('meta/')
}

describe('tool naming convention (issue #129)', () => {
  it('every tool file declares a string-literal name inside a define*Tool({ ... }) call', async () => {
    const files = await listHttpToolFiles(HTTP_TOOLS_DIR)
    expect(files.length, 'HTTP tools directory unexpectedly empty').toBeGreaterThan(0)

    const missing: string[] = []
    for (const file of files) {
      const name = await extractToolName(file)
      if (!name) missing.push(relative(PROJECT_ROOT, file))
    }
    expect(
      missing,
      'These tool files have no string-literal `name:` field inside their `defineMcpTool({ ... })` (or `define*Tool({ ... })` factory) call. The naming guard cannot validate them. If you used shorthand `{ name }` or a const reference, inline the literal so the guard and IDE rename can both see it.',
    ).toEqual([])
  })

  it('every tool name matches its directory: b24_* outside meta/, bx24mcp_* inside meta/', async () => {
    // The `if (!name) continue` skips files already flagged by the previous
    // it() — that one is the authoritative source for "no string-literal
    // name". Splitting the assertion lets each failure have a focused
    // diagnostic instead of a confused "regex didn't match null".
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
    // `b24_task_results_list`. Walk EVERY token after the prefix (including
    // the trailing action) and reject `*s` unless it's in the small
    // singular-on-s allowlist. Yes, the action verb is checked too — that's
    // intentional, because `b24_task_creates` would be just as wrong as
    // `b24_tasks_create`. Skip only `tokens[0]` (the `b24` / `bx24mcp`
    // prefix), nothing else.
    const files = await listHttpToolFiles(HTTP_TOOLS_DIR)
    const violations: { file: string, name: string, badToken: string }[] = []
    for (const file of files) {
      const name = await extractToolName(file)
      if (!name) continue // see comment in the previous it()
      const tokens = name.split('_')
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

  it('`_me` shape is restricted to the `user` domain', async () => {
    // `b24_user_me` exists as the canonical identity tool. Without this
    // check the b24 regex would also accept `b24_task_me`, `b24_calendar_me`,
    // `b24_disk_me`, … any of which could quietly land in a future PR
    // and reframe `_me` as a generic "mine" suffix — defeating the
    // entity+action overload that makes it work for the operator pronoun.
    // Opening a new `_me` form requires extending ME_DOMAIN_ALLOWLIST AND
    // updating the convention docs in the same PR.
    const files = await listHttpToolFiles(HTTP_TOOLS_DIR)
    const violations: { file: string, name: string, domain: string }[] = []
    for (const file of files) {
      const name = await extractToolName(file)
      if (!name) continue
      const m = name.match(ME_SHAPE_RE)
      if (m && !ME_DOMAIN_ALLOWLIST.has(m[1]!)) {
        violations.push({ file: relative(PROJECT_ROOT, file), name, domain: m[1]! })
      }
    }

    expect(
      violations,
      '`_me` is allowed only for domains in ME_DOMAIN_ALLOWLIST (currently: `user`). For "mine" semantics on other entities, use a filter on `_list` (e.g. `b24_task_list { responsibleId: me-id }`), not a separate tool. Extending the allowlist requires a convention update in skills/manage-bx24-template-mcp/adding-tools.md and docs/ADDING-TOOLS.md.',
    ).toEqual([])
  })

  it('regexes cross-reject the other family + key positive cases (defence in depth)', () => {
    // A tool file misplaced under `meta/` with a `b24_*` name (or vice-versa)
    // is caught by the per-directory check above, but only because the regex
    // for the wrong family rejects the name. Pin that contract here so a
    // future loosening of either regex can't silently re-enable the bug.
    expect(B24_NAME_RE.test('bx24mcp_submit_feedback'), 'B24 regex must reject bx24mcp_ prefix').toBe(false)
    expect(META_NAME_RE.test('b24_user_me'), 'META regex must reject b24_ prefix').toBe(false)
    expect(B24_NAME_RE.test('bitrix24_create_task'), 'B24 regex must reject legacy bitrix24_ prefix').toBe(false)
    expect(META_NAME_RE.test('bitrix24_create_task'), 'META regex must reject legacy bitrix24_ prefix').toBe(false)

    // Positive contract for canonical names — if any of these ever fails,
    // the regex was tightened too far.
    expect(B24_NAME_RE.test('b24_task_create')).toBe(true)
    expect(B24_NAME_RE.test('b24_user_me')).toBe(true)
    expect(B24_NAME_RE.test('b24_task_checklist_item_add')).toBe(true)
    expect(META_NAME_RE.test('bx24mcp_submit_feedback')).toBe(true)
  })

  it('singular-on-s whitelist entries pass the guard (regression: don\'t shrink the whitelist by accident)', () => {
    // If someone deletes a whitelist entry the singular-check will start
    // rejecting names containing that entry. Pin the canonical forms so
    // a regression surfaces here with a clear diagnostic, not in a future
    // PR adding `b24_task_status_update` that suddenly fails CI.
    const probeNames = [
      'b24_task_status_update', // 'status'
      'b24_user_address_get', //   'address'
      'b24_task_progress_get', //  'progress'
      'b24_crm_business_find', //  'business'
    ]
    for (const name of probeNames) {
      // Sanity: each test name must itself be regex-valid (otherwise the
      // probe is testing nothing).
      expect(B24_NAME_RE.test(name), `probe name ${name} must match B24 regex`).toBe(true)
      const tokens = name.split('_')
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i]!
        if (t.endsWith('s')) {
          expect(
            SINGULAR_S_WHITELIST.has(t),
            `Token \`${t}\` (from probe \`${name}\`) must be in SINGULAR_S_WHITELIST — removing it would reject legitimate singular-on-s nouns.`,
          ).toBe(true)
        }
      }
    }
  })

  it('`_me` shape rejects non-user domains (regression for the ME_DOMAIN_ALLOWLIST check)', () => {
    // Make the `_me` restriction observable in isolation: even though the
    // file-scanning it() above already enforces it for live tools, this
    // pin documents the contract for a reader skimming the test and
    // catches a regression where someone widens ME_DOMAIN_ALLOWLIST or
    // ME_SHAPE_RE without updating the convention docs.
    const probe = (name: string): boolean => {
      const m = name.match(ME_SHAPE_RE)
      return !!(m && ME_DOMAIN_ALLOWLIST.has(m[1]!))
    }
    expect(probe('b24_user_me'), 'b24_user_me must be accepted').toBe(true)
    expect(probe('b24_task_me'), 'b24_task_me must be rejected — `_me` is user-only').toBe(false)
    expect(probe('b24_calendar_me'), 'b24_calendar_me must be rejected').toBe(false)
    expect(probe('b24_task_create'), 'non-`_me` names are out of scope for this check').toBe(false)
  })
})
