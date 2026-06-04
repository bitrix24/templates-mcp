import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
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
  name: 'b24_task_elapsed_time_list',
  description:
    'List elapsed-time entries on Bitrix24 tasks. Use this to read what was logged via `b24_task_elapsed_time_add` (or via the Bitrix24 stopwatch — both flows write to the same table). Filter by `taskId` for a single-task view, or pass `filter` with camelCase keys + operator prefixes (e.g. { ">=createdDate": "2025-01-01", userId: 5 }) for a custom slice. Page size is fixed at 50 by Bitrix24; use `start` for pagination (multiples of 50). Returns id, taskId, userId, commentText, seconds, createdDate, and the stopwatch dateStart / dateStop timestamps (camelCase in the JSON response).',
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
      .max(100_000)
      .optional()
      .describe(
        'Pagination offset (0 = first page, 50 = second, …). Must be a multiple of 50 — Bitrix24 v2 `getlist` paginates by 1-based page number, and non-multiple offsets round DOWN to the start of the containing page (e.g. start=75 → page 2 starting at 50). Capped at 100_000 to guard against accidental huge offsets. Omit for first page.',
      ),
  },
  handler: async ({ taskId, filter, order, select, start }) => {
    const b24 = useBitrix24Tenant()

    // Merge `taskId` convenience field into the filter unless the operator
    // already supplied any TASK_ID-shaped key — including operator-prefix
    // variants like `!taskId` or `>=TASK_ID`. Without the prefix-stripped
    // check, `{ taskId: 91, filter: { '!taskId': 5 } }` would emit a
    // contradictory filter on the wire (both equality and not-equal on
    // TASK_ID). The strip pattern matches `normalizeBitrix24Key`'s
    // operator prefix set: `!`, `%`, `>=`, `<=`, `>`, `<`.
    const mergedFilter: Record<string, unknown> = { ...(filter ?? {}) }
    const taskIdAlreadyFiltered = Object.keys(mergedFilter).some((k) => {
      const fieldName = k.replace(/^[!%<>=]+/, '')
      return fieldName === 'taskId' || fieldName === 'TASK_ID'
    })
    if (taskId !== undefined && !taskIdAlreadyFiltered) {
      mergedFilter.taskId = taskId
    }

    // Bitrix24 v2 `getlist` uses 1-based `iNumPage` for pagination, not the
    // v3-style byte-offset `start`. Convert the operator-friendly `start`
    // (offset) into `iNumPage` so the agent doesn't have to do math. Page
    // size is fixed at 50; sub-page offsets round down to the start of
    // their containing page (documented in the `start` field describe).
    //
    // TODO(live): the unit tests verify the iNumPage math via mocks — they
    // do NOT verify that Bitrix24 actually honours `NAV_PARAMS.iNumPage` on
    // this endpoint. The v2 `getlist` family is documented at
    // apidocs.bitrix24.ru but the pagination contract varies subtly per
    // endpoint. Re-verify against a real portal once Phase 2 pilot has live
    // data with >50 elapsed-time entries on a single task, or via the
    // integration tests once they grow a setup that generates that volume.
    const pageSize = 50
    const iNumPage = Math.floor((start ?? 0) / pageSize) + 1
    const data = await callV2<unknown[] | { result?: unknown[] }>(
      b24,
      'task.elapseditem.getlist',
      {
        ORDER: order ? normalizeBitrix24Order(order) : { ID: 'desc' },
        FILTER: Object.keys(mergedFilter).length > 0 ? normalizeBitrix24Filter(mergedFilter) : {},
        SELECT: select ? normalizeBitrix24Select(select) : DEFAULT_SELECT_WIRE,
        PARAMS: { NAV_PARAMS: { iNumPage, nPageSize: pageSize } },
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
