import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { TaskListEnvelope } from '~/server/types/bitrix24'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'
import {
  normalizeBitrix24Filter,
  normalizeBitrix24Order,
  normalizeBitrix24Select,
  toTaskShort,
  type TaskShort,
} from '~/server/utils/tasks'

const DEFAULT_SELECT_CAMEL = ['id', 'title', 'status', 'deadline', 'responsibleId', 'createdDate', 'priority']
const DEFAULT_SELECT_WIRE = normalizeBitrix24Select(DEFAULT_SELECT_CAMEL)

/**
 * Lists Bitrix24 tasks with filter / order / pagination.
 *
 * Bitrix24 REST: tasks.task.list
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-list.html
 *
 * This is the classic `tasks.task.*` API, served on the v2 transport
 * (`callV2`). rest-v3 does NOT implement `tasks.task.list` ("restApi:v3 not
 * support method tasks.task.list"), so it must go through v2. The wire
 * contract for `filter` / `order` / `select` is legacy `UPPER_SNAKE_CASE`.
 * We accept camelCase from the LLM (matching every other task tool in this
 * MCP) and translate to UPPER_SNAKE at the boundary via `normalizeBitrix24Key`.
 * Legacy UPPERCASE input is passed through unchanged, so callers that learned
 * the old contract still work.
 *
 * Page size is fixed at 50 by Bitrix24. Use `start` to paginate
 * (start = (pageNumber - 1) * 50).
 */
export default defineMcpTool({
  name: 'b24_task_list',
  description:
    'List Bitrix24 tasks. Filter / order / select keys are camelCase task fields (`responsibleId`, `status`, `deadline`, `groupId`, …) — same convention as every other task tool. Legacy UPPERCASE keys (`RESPONSIBLE_ID`, `STATUS`, …) are also accepted. Page size is fixed at 50 by Bitrix24; use `start` for pagination ((page-1)*50). Returns a trimmed list — id/title/status/deadline/responsibleId/createdDate.',
  inputSchema: {
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Filter object. Keys are camelCase task fields with optional operator prefixes: `!` (not equal), `>=` / `<=` (range), `%` (LIKE). Examples: { responsibleId: 5 } | { "!status": 5 } (not completed) | { ">=deadline": "2026-05-16T00:00:00+03:00" } (deadline today or later) | { "%title": "договор" } (LIKE match on title). UPPERCASE forms (RESPONSIBLE_ID, "!STATUS", …) also accepted. Omit for no filter (returns the most recent 50).',
      ),
    order: z
      .record(z.string(), z.enum(['asc', 'desc']))
      .optional()
      .describe(
        'Sort. Keys are camelCase field names (`deadline`, `priority`, `createdDate`, …; UPPERCASE accepted). Default is { id: "desc" } (newest first).',
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
  handler: async ({ filter, order, select, start }) => {
    const b24 = useBitrix24Tenant()
    const data = await callV2<TaskListEnvelope>(
      b24,
      'tasks.task.list',
      {
        filter: filter ? normalizeBitrix24Filter(filter) : {},
        order: order ? normalizeBitrix24Order(order) : { ID: 'desc' },
        select: select ? normalizeBitrix24Select(select) : DEFAULT_SELECT_WIRE,
        start: start ?? 0,
      },
      'Failed to list Bitrix24 tasks',
    )
    const tasks: TaskShort[] = (data?.tasks ?? [])
      .map(toTaskShort)
      .filter((t): t is TaskShort => t !== null)

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            // Bitrix24 normally returns `total` (count across all pages).
            // Fall back to `null` if the API didn't supply it — reporting
            // the page-slice length would silently lie about pagination.
            total: typeof data?.total === 'number' ? data.total : null,
            returned: tasks.length,
            tasks,
          }),
        },
      ],
    }
  },
})
