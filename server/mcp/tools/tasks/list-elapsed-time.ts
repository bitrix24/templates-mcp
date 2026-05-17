import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { toElapsedTimeShort, type ElapsedTimeShort } from '~/server/utils/elapsed-time'
import { callV2 } from '~/server/utils/sdk-helpers'
import {
  normalizeBitrix24Filter,
  normalizeBitrix24Order,
  normalizeBitrix24Select,
} from '~/server/utils/tasks'

/**
 * List elapsed-time entries on a Bitrix24 task (or across tasks, with a
 * filter).
 *
 * Bitrix24 REST: task.elapseditem.getlist (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/tasks/elapsed-item/task-elapsed-item-get-list.html
 *
 * The REST shape accepts ORDER / FILTER / SELECT / PARAMS objects with the
 * legacy UPPER_SNAKE_CASE keys. We accept v3-friendly camelCase (matching
 * every other task tool) and normalise via `normalizeBitrix24Filter` /
 * `normalizeBitrix24Order` / `normalizeBitrix24Select`.
 *
 * `taskId` lives in the input schema as a top-level **convenience** field,
 * not a hard requirement — Bitrix24 itself permits unfiltered listings, but
 * those scan the whole portal and almost always over-fetch for an agent
 * workflow. We translate the convenience field into `FILTER.TASK_ID` if
 * supplied, while still allowing the agent to override via an explicit
 * `filter: { taskId: ... }`. If neither is set, the underlying API returns
 * the most recent entries across all tasks the webhook user can see.
 */

const DEFAULT_SELECT_CAMEL = [
  'id',
  'taskId',
  'userId',
  'commentText',
  'seconds',
  'createdDate',
  'dateStart',
  'dateStop',
]
const DEFAULT_SELECT_WIRE = normalizeBitrix24Select(DEFAULT_SELECT_CAMEL)

export default defineMcpTool({
  name: 'bitrix24_list_elapsed_time',
  description:
    'List elapsed-time entries on Bitrix24 tasks. Use this to read what was logged via `bitrix24_add_elapsed_time` (or via the Bitrix24 stopwatch — both flows write to the same table). Filter by `taskId` for a single-task view, or pass `filter` with camelCase keys + operator prefixes (e.g. { ">=createdDate": "2025-01-01", userId: 5 }) for a custom slice. Page size is fixed at 50 by Bitrix24; use `start` for pagination. Returns id, taskId, userId, commentText, seconds, createdDate, and the stopwatch DATE_START / DATE_STOP timestamps.',
  inputSchema: {
    taskId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Convenience filter — restrict the listing to a single task. Translated into `filter.TASK_ID` on the wire. Omit (and omit `filter` too) for a portal-wide listing; expect over-fetch.',
      ),
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Filter object. Keys are camelCase elapsed-time fields with optional operator prefixes: `!` (not equal), `>=` / `<=` (range), `%` (LIKE). Examples: { userId: 5 } | { ">=createdDate": "2025-01-01" } (logged today or later) | { "%commentText": "договор" } (LIKE match). UPPERCASE keys (TASK_ID, USER_ID, …) also accepted. Omit for no filter (combined with `taskId` if that is set).',
      ),
    order: z
      .record(z.string(), z.enum(['asc', 'desc']))
      .optional()
      .describe(
        'Sort. Keys are camelCase field names (`id`, `createdDate`, …). Default is { id: "desc" } — newest first.',
      ),
    select: z
      .array(z.string())
      .optional()
      .describe(
        `Fields to return as camelCase names. Defaults to ${DEFAULT_SELECT_CAMEL.join(', ')}. UPPERCASE forms accepted. Always set this explicitly when you need a predictable shape.`,
      ),
    start: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Pagination offset (0 = first page, 50 = second, …). Omit for first page.'),
  },
  handler: async ({ taskId, filter, order, select, start }) => {
    const b24 = useBitrix24()

    // Merge `taskId` convenience field into the filter unless the operator
    // already supplied an explicit TASK_ID-shaped key. We do the merge BEFORE
    // normalisation so the conflict detection in `normalizeBitrix24Filter`
    // catches the redundant-key case loudly.
    const mergedFilter: Record<string, unknown> = { ...(filter ?? {}) }
    if (taskId !== undefined && !('taskId' in mergedFilter) && !('TASK_ID' in mergedFilter)) {
      mergedFilter.taskId = taskId
    }

    // Bitrix24 v2 `getlist` family ignores SELECT when called via the
    // object-form (it returns the full row); SELECT is only honoured in the
    // positional-form. We still pass it through normalisation so a future
    // SDK / endpoint upgrade picks it up without a tool-side change.
    const data = await callV2<{ result?: unknown[] } | unknown[]>(
      b24,
      'task.elapseditem.getlist',
      {
        ORDER: order ? normalizeBitrix24Order(order) : { ID: 'desc' },
        FILTER: Object.keys(mergedFilter).length > 0 ? normalizeBitrix24Filter(mergedFilter) : {},
        SELECT: select ? normalizeBitrix24Select(select) : DEFAULT_SELECT_WIRE,
        PARAMS: { NAV_PARAMS: { iNumPage: 1, nPageSize: 50, start: start ?? 0 } },
      },
      'Failed to list Bitrix24 elapsed-time entries',
    )

    // Bitrix24 ships getlist results as a bare array at `result`; the SDK
    // unwraps the envelope so we receive the array directly (or an object
    // with `.result` for some legacy shapes — we handle both for resilience).
    const items: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray((data as { result?: unknown[] })?.result)
        ? ((data as { result?: unknown[] }).result ?? [])
        : []

    const entries: ElapsedTimeShort[] = items
      .map(toElapsedTimeShort)
      .filter((e): e is ElapsedTimeShort => e !== null)

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            // Pagination contract mirrors list-task-results: Bitrix24 v2
            // getlist DOES ship a `total` separately, but the SDK strips it
            // from the unwrapped result. Report `returned` so the agent
            // compares against the requested page size to detect "end of
            // list" — same idiom as the v3 list tools.
            returned: entries.length,
            entries,
          }),
        },
      ],
    }
  },
})
