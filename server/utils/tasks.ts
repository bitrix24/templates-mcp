/**
 * Shared types and helpers for the Bitrix24 task tools.
 *
 * Bitrix24 REST returns task fields in mixed casing (UPPERCASE for legacy
 * v2-style endpoints, camelCase for v3 responses). The four task tools
 * (`b24_task_create` / `_list_tasks` / `_update_task` /
 * `_add_task_comment`) accept inputs in camelCase (more LLM-friendly) and
 * map them to the UPPERCASE keys that the REST methods actually require.
 */

import { pick, toBool } from '~/server/utils/wire-coerce'

/** Subset of task fields we surface back to the agent. The full Bitrix24
 *  response carries 50+ fields; trimming to the agent-useful ones keeps the
 *  context window cheap. Agents that need more should use list-tasks with an
 *  explicit `select`.
 *
 *  `description` is the one field that is **opt-in per call** rather than
 *  always-on — see {@link ToTaskShortOptions}. */
export interface TaskShort {
  id: number | string
  title: string
  status?: string
  deadline?: string | null
  responsibleId?: string
  createdDate?: string
  priority?: string
  /** Scalar fields Bitrix24 ships **only when they are in the `select`**, so
   *  projecting them when present is the same thing as honouring the select.
   *  They stay absent from a default listing. Issue #203 reported them
   *  dropped alongside `description`. */
  groupId?: string
  createdBy?: string
  parentId?: string
  changedDate?: string | null
  closedDate?: string | null
  /** The task body. Only present when the caller opted in AND Bitrix24
   *  actually shipped it (i.e. `description` was in the `select`). */
  description?: string
  /** Bitrix24's `DESCRIPTION_IN_BBCODE` flag ("Y"/"N" on the wire), coerced
   *  to a boolean: `true` → `description` holds BBCode, `false` → HTML. Ships
   *  alongside `description` and tells the agent how to read the markup. */
  descriptionInBbcode?: boolean
}

export interface ToTaskShortOptions {
  /**
   * Project `description` / `descriptionInBbcode` when the wire carries them.
   *
   * Off by default, and deliberately so: a task body runs to hundreds or
   * thousands of characters, and `toTaskShort` is shared by every task tool
   * — create / update / rate / the seven lifecycle verbs all project their
   * response through it. Bitrix24 echoes the full task on those endpoints, so
   * an always-on `description` would bill the agent for a body it just wrote
   * on every single mutation. Only the read path (`b24_task_list`, when the
   * operator puts `description` in the `select`) asks for it.
   *
   * Issue #203: before this option existed the field was dropped
   * unconditionally, so `select: ['id', 'title', 'description']` silently
   * returned no body — the `select` looked honoured but the projection ate it.
   */
  withDescription?: boolean
}

export function toTaskShort(raw: unknown, options: ToTaskShortOptions = {}): TaskShort | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = pick<number | string>(r, 'id', 'ID')
  const title = pick<string>(r, 'title', 'TITLE')
  if (id === null || title === null) return null
  const short: TaskShort = {
    id,
    title,
    status: pick<string>(r, 'status', 'STATUS') ?? undefined,
    deadline: pick<string>(r, 'deadline', 'DEADLINE') ?? undefined,
    responsibleId: pick<string>(r, 'responsibleId', 'RESPONSIBLE_ID') ?? undefined,
    createdDate: pick<string>(r, 'createdDate', 'CREATED_DATE') ?? undefined,
    priority: pick<string>(r, 'priority', 'PRIORITY') ?? undefined,
  }
  // Bitrix24 omits these unless selected, so "present on the wire" already
  // means "the operator asked for it" — no flag needed. Deliberately NOT
  // projected: the nested `group` / `creator` objects Bitrix24 adds unbidden
  // next to `groupId` / `createdBy` (they carry member counts, avatar URLs
  // and work positions — a lot of tokens nobody asked for).
  const scalars: [keyof TaskShort, string, string][] = [
    ['groupId', 'groupId', 'GROUP_ID'],
    ['createdBy', 'createdBy', 'CREATED_BY'],
    ['parentId', 'parentId', 'PARENT_ID'],
    ['changedDate', 'changedDate', 'CHANGED_DATE'],
    ['closedDate', 'closedDate', 'CLOSED_DATE'],
  ]
  for (const [key, lower, upper] of scalars) {
    const value = pick<string>(r, lower, upper)
    if (value !== null) Object.assign(short, { [key]: value })
  }

  if (options.withDescription) {
    // An empty description is a real state (a task with no body), so `''`
    // is surfaced as-is; only an absent field stays absent.
    const description = pick<string>(r, 'description', 'DESCRIPTION')
    if (description !== null) short.description = description
    // The flag only means something next to a description, and Bitrix24
    // ships it automatically whenever DESCRIPTION is selected.
    const inBbcode = pick<string | boolean>(r, 'descriptionInBbcode', 'DESCRIPTION_IN_BBCODE')
    if (inBbcode !== null) short.descriptionInBbcode = typeof inBbcode === 'boolean' ? inBbcode : toBool(inBbcode)
  }
  return short
}

/**
 * Bitrix24's `tasks.task.list` returns `{result: {tasks: [...], total: N}}`.
 * Some other endpoints (e.g. `tasks.task.add`) wrap in `{result: {task: {...}}}`.
 * This function tolerates both shapes and a few null variants.
 */
export function extractTasks(rawResult: unknown, options: ToTaskShortOptions = {}): TaskShort[] {
  if (!rawResult || typeof rawResult !== 'object') return []
  const r = rawResult as Record<string, unknown>
  const tasks = r.tasks ?? r.task
  if (Array.isArray(tasks)) {
    return tasks.map((t) => toTaskShort(t, options)).filter((t): t is TaskShort => t !== null)
  }
  if (tasks && typeof tasks === 'object') {
    const single = toTaskShort(tasks, options)
    return single ? [single] : []
  }
  return []
}

/**
 * Bitrix24's task statuses are integers stringified in the REST layer.
 * Documented values (subset relevant for filtering / display):
 *   1 — new (исп. редко в прод-портал, обычно сразу 2)
 *   2 — pending / in queue
 *   3 — in progress
 *   4 — supposedly completed
 *   5 — completed
 *   6 — deferred
 *   7 — declined
 */
export const TASK_STATUS = {
  PENDING: 2,
  IN_PROGRESS: 3,
  COMPLETED_PROVISIONAL: 4,
  COMPLETED: 5,
  DEFERRED: 6,
  DECLINED: 7,
} as const

/**
 * Normalise a Bitrix24 task filter / select / order key from camelCase
 * (v3-friendly, what every other task tool in this MCP accepts) into the
 * legacy `UPPER_SNAKE_CASE` form that `tasks.task.list` actually expects on
 * the wire. Already-UPPERCASE keys are returned unchanged so back-compat is
 * preserved for callers that learned the legacy contract from previous
 * releases.
 *
 * Operator prefixes (`!`, `%`, `>=`, `<=`, `>`, `<`) are detected and
 * forwarded verbatim, so `>=deadline` becomes `>=DEADLINE`, `!status`
 * becomes `!STATUS`, `%title` becomes `%TITLE`.
 *
 * Why this lives here: `tasks.task.list` lives in the `tasks.task.*` v3
 * namespace but accepts only the legacy UPPER_SNAKE filter contract. The
 * mutation methods (`tasks.task.start` / `.update` / etc.) take camelCase.
 * Without this normaliser, LLM-driven workflows would have to switch
 * contracts mid-flow — friction we can absorb in one place and forget.
 */
/** Reserved JS identifiers that must never reach the REST wire as field
 *  names — mirrors `FORBIDDEN_KEYS` in `v3-filter.ts` (issue #22). `JSON.parse`
 *  makes `__proto__` an own enumerable property in modern V8, so an
 *  LLM-routed `{"__proto__": …}` arrives as a normal key here. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** True if `key` is forbidden either verbatim or after stripping an operator
 *  prefix (`!`/`%`/`<`/`>`/`=`) — so both `__proto__` and `!__proto__` are
 *  caught, matching the two-stage check in `v3-filter.ts`. */
function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(key) || FORBIDDEN_KEYS.has(key.replace(/^[!%<>=]+/, ''))
}

export function normalizeBitrix24Key(key: string): string {
  const match = /^([!%<>=]*)(.+)$/.exec(key)
  if (!match) return key
  const prefix = match[1] ?? ''
  const field = match[2] ?? ''
  if (!field) return key
  // Already UPPER_SNAKE → keep as-is (no surprise mutation of legacy keys).
  if (/^[A-Z][A-Z0-9_]*$/.test(field)) return prefix + field
  // camelCase or PascalCase → UPPER_SNAKE.
  // The negative-lookbehind `(?<!^)` skips the very first character so
  // PascalCase inputs like `Title` / `>=Deadline` don't get a leading
  // underscore (`_TITLE` / `>=_DEADLINE` would be silently rejected by
  // Bitrix24).
  const snake = field.replace(/(?<!^)([A-Z])/g, '_$1').toUpperCase()
  return prefix + snake
}

/**
 * Translate every key of a filter object via {@link normalizeBitrix24Key}.
 *
 * Throws if two input keys collide after normalisation (e.g. `responsibleId`
 * and `RESPONSIBLE_ID` in the same filter). A silent drop of the earlier
 * value would be the worst class of bug — the call still succeeds, the LLM
 * thinks the filter is honoured, but one criterion has quietly vanished.
 */
export function normalizeBitrix24Filter(filter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(filter)) {
    if (isForbiddenKey(k)) continue
    const normalised = normalizeBitrix24Key(k)
    if (Object.prototype.hasOwnProperty.call(out, normalised)) {
      throw new Error(
        `Duplicate Bitrix24 filter key after normalisation: "${k}" maps to "${normalised}" which is already set. Use one casing per field — camelCase preferred.`,
      )
    }
    out[normalised] = v
  }
  return out
}

/**
 * Translate every key of an order map via {@link normalizeBitrix24Key}.
 * Same collision check as {@link normalizeBitrix24Filter}.
 */
export function normalizeBitrix24Order<T>(order: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(order)) {
    if (isForbiddenKey(k)) continue
    const normalised = normalizeBitrix24Key(k)
    if (Object.prototype.hasOwnProperty.call(out, normalised)) {
      throw new Error(
        `Duplicate Bitrix24 order key after normalisation: "${k}" maps to "${normalised}" which is already set. Use one casing per field — camelCase preferred.`,
      )
    }
    out[normalised] = v
  }
  return out
}

/**
 * Translate every field name in a select array via {@link normalizeBitrix24Key}
 * and deduplicate the result. Duplicates on the wire are harmless to
 * Bitrix24 (it returns the field once anyway), but removing them here keeps
 * the payload tidy and makes the eventual wire log match the caller's
 * intent.
 */
export function normalizeBitrix24Select(select: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const key of select) {
    if (isForbiddenKey(key)) continue
    const normalised = normalizeBitrix24Key(key)
    if (seen.has(normalised)) continue
    seen.add(normalised)
    out.push(normalised)
  }
  return out
}
