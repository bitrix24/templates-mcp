import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { TaskResultListEnvelope } from '~/server/types/bitrix24'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV3 } from '~/server/utils/sdk-helpers'
import { toTaskResultShort, type TaskResultShort } from '~/server/utils/task-results'
import { toV3Filter } from '~/server/utils/v3-filter'

/**
 * List all results recorded on a Bitrix24 task.
 *
 * Bitrix24 REST: tasks.task.result.list (v3)
 *   https://apidocs.bitrix24.com/api-reference/rest-v3/tasks/result/tasks-task-result-list.html
 *
 * The v3 API REQUIRES a `taskId` filter on this endpoint; calling it without
 * one returns `BITRIX_REST_V3_EXCEPTION_VALIDATION_REQUESTFILTERVALIDATIONEXCEPTION`.
 * We bake `taskId` into the schema as a top-level field instead of asking the
 * agent to construct the v3 filter array by hand.
 */

const SORT_FIELDS = ['id', 'authorId', 'createdAt', 'updatedAt', 'status', 'messageId'] as const

export default defineMcpTool({
  name: 'b24_task_result_list',
  description:
    'List the results recorded on a Bitrix24 task. Each result is a free-form text entry capturing the outcome of the work (see `b24_task_result_add`). Default order is newest-first by createdAt. Use this to read what was delivered after a task closed, or to find the latest result for an audit narrative. Pagination is offset-based; Bitrix24 v3 does NOT return a total count, so to know whether more pages exist compare `returned` against your `limit` — if `returned < limit` you have reached the end.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id to list results for. Required by the Bitrix24 v3 endpoint.'),
    order: z
      .object({
        field: z
          .enum(SORT_FIELDS)
          .describe('Sort field. `createdAt` matches "when written"; `id` ascending matches insertion order.'),
        direction: z.enum(['asc', 'desc']).describe('Sort direction.'),
      })
      .optional()
      .describe('Sort order. Default `{ field: "createdAt", direction: "desc" }` — newest first.'),
    limit: z.number().int().positive().max(100).optional().describe('Page size. Default 50; max 100.'),
    offset: z.number().int().nonnegative().optional().describe('Pagination offset. Default 0.'),
  },
  handler: async ({ taskId, order, limit, offset }) => {
    const sort = order ?? { field: 'createdAt' as const, direction: 'desc' as const }
    const b24 = useBitrix24()
    const result = await callV3<TaskResultListEnvelope>(
      b24,
      'tasks.task.result.list',
      {
        // v3 filter is an array-of-conditions; the docs specifically require
        // a taskId condition for this endpoint. `toV3Filter` handles the
        // shape so we keep one contract across every v3 list endpoint.
        filter: toV3Filter({ taskId }),
        order: { [sort.field]: sort.direction.toUpperCase() },
        select: ['id', 'taskId', 'text', 'authorId', 'createdAt', 'updatedAt', 'status', 'messageId'],
        pagination: { limit: limit ?? 50, offset: offset ?? 0 },
      },
      `Failed to list Bitrix24 task results for task ${taskId}`,
    )

    const items: TaskResultShort[] = Array.isArray(result?.items)
      ? (result.items
          .map(toTaskResultShort)
          .filter((r): r is TaskResultShort => r !== null) as TaskResultShort[])
      : []

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            taskId,
            returned: items.length,
            results: items,
          }),
        },
      ],
    }
  },
})
