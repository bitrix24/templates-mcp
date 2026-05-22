import type { BitrixElapsedTimeRaw } from '~/server/types/bitrix24'
import { pick, toNumber } from '~/server/utils/wire-coerce'

/**
 * Pure parser for `task.elapseditem.*` response items. Mirrors what
 * `toTaskShort` / `toChecklistItemShort` / `toTaskResultShort` do for their
 * respective domains: narrow the agent-facing shape, coerce stringified
 * numeric fields, leave the tool bodies free of wire-format quirks.
 *
 * Returns `null` when the wire shape is missing the minimum identifiers
 * (`id` and `taskId`). Same fail-soft convention as the sibling parsers —
 * the caller gets `null` and decides how to surface "couldn't read this".
 */

export interface ElapsedTimeShort {
  id: number
  taskId: number
  userId: number | null
  commentText: string
  seconds: number
  createdDate: string | null
  /** Bitrix24's `DATE_START` — when the stopwatch session began.
   *  For manual entries posted via `task.elapseditem.add` (without a
   *  stopwatch), Bitrix24 sets this to the CREATED_DATE; the two will
   *  often match. Empty string on the wire is normalised to null. */
  dateStart: string | null
  /** Bitrix24's `DATE_STOP` — when the stopwatch session ended. Same
   *  manual-entry behaviour and null normalisation as `dateStart`. */
  dateStop: string | null
}

export function toElapsedTimeShort(raw: unknown): ElapsedTimeShort | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as BitrixElapsedTimeRaw & Record<string, unknown>
  const id = toNumber(pick(r, 'id', 'ID'))
  const taskId = toNumber(pick(r, 'taskId', 'TASK_ID'))
  if (id === null || taskId === null) return null
  return {
    id,
    taskId,
    userId: toNumber(pick(r, 'userId', 'USER_ID')),
    // COMMENT_TEXT may be missing or empty on a stopwatch-only entry; default
    // to '' so the projection shape stays stable.
    commentText: pick<string>(r, 'commentText', 'COMMENT_TEXT') ?? '',
    // SECONDS is the canonical duration. Missing → 0 (Bitrix24 occasionally
    // ships zero-second entries for stopwatch start markers; surfacing
    // them as 0 keeps the projection shape stable). Sibling parsers like
    // `toTaskShort` would return `null` for a missing numeric — the choice
    // here is intentionally different because `seconds` is the headline
    // field every agent reads, and `null` would force the LLM through a
    // null-check it doesn't need for the stopwatch-marker case.
    seconds: toNumber(pick(r, 'seconds', 'SECONDS')) ?? 0,
    createdDate: pick<string>(r, 'createdDate', 'CREATED_DATE') || null,
    dateStart: pick<string>(r, 'dateStart', 'DATE_START') || null,
    dateStop: pick<string>(r, 'dateStop', 'DATE_STOP') || null,
  }
}
