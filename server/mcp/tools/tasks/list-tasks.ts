import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { toToolError } from '~/server/utils/errors'
import { toTaskShort, type TaskShort } from '~/server/utils/tasks'

const DEFAULT_SELECT = ['ID', 'TITLE', 'STATUS', 'DEADLINE', 'RESPONSIBLE_ID', 'CREATED_DATE', 'PRIORITY']

/**
 * Lists Bitrix24 tasks with filter / order / pagination.
 *
 * Bitrix24 REST: tasks.task.list
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-list.html
 *
 * Page size is fixed at 50 by Bitrix24. Use `start` to paginate
 * (start = (pageNumber - 1) * 50).
 */
export default defineMcpTool({
  name: 'bitrix24_list_tasks',
  description:
    'List Bitrix24 tasks. Filter keys are UPPERCASE (e.g. RESPONSIBLE_ID, STATUS, "!STATUS", ">=DEADLINE", GROUP_ID). Page size is fixed at 50 by Bitrix24. Use `start` for pagination ((page-1)*50). Returns a trimmed list — id/title/status/deadline/responsibleId/createdDate.',
  inputSchema: {
    filter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Filter object. Keys are UPPERCASE Bitrix24 task fields with optional operator prefixes: `!` (not equal), `>=` / `<=` (range), `%` (LIKE). Examples: { RESPONSIBLE_ID: 5 } | { "!STATUS": 5 } (not completed) | { ">=DEADLINE": "2026-05-16T00:00:00+03:00" } (deadline today or later) | { "%TITLE": "договор" } (LIKE match on title). Omit for no filter (returns the most recent 50).',
      ),
    order: z
      .record(z.string(), z.enum(['asc', 'desc']))
      .optional()
      .describe(
        'Sort. Keys are UPPERCASE field names (DEADLINE, PRIORITY, CREATED_DATE, …). Default is { ID: "desc" } (newest first).',
      ),
    select: z
      .array(z.string())
      .optional()
      .describe(
        `Fields to return. Defaults to ${DEFAULT_SELECT.join(', ')}. Always set this explicitly when you need predictable shape.`,
      ),
    start: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Pagination offset (0 = first page, 50 = second, …). Omit for first page.'),
  },
  handler: async ({ filter, order, select, start }) => {
    try {
      const b24 = useBitrix24()
      const response = await b24.callMethod('tasks.task.list', {
        filter: filter ?? {},
        order: order ?? { ID: 'desc' },
        select: select ?? DEFAULT_SELECT,
        start: start ?? 0,
      })
      const data = response.getData()?.result as { tasks?: unknown[]; total?: number } | undefined
      const tasks: TaskShort[] = (data?.tasks ?? [])
        .map(toTaskShort)
        .filter((t): t is TaskShort => t !== null)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                // Bitrix24 normally returns `total` (count across all pages).
                // Fall back to `null` if the API didn't supply it — reporting
                // the page-slice length would silently lie about pagination.
                total: typeof data?.total === 'number' ? data.total : null,
                returned: tasks.length,
                tasks,
              },
              null,
              2,
            ),
          },
        ],
      }
    } catch (err) {
      throw toToolError(err, 'Failed to list Bitrix24 tasks')
    }
  },
})
