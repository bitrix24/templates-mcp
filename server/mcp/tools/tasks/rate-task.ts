import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { toToolError } from '~/server/utils/errors'
import { extractTasks } from '~/server/utils/tasks'

/**
 * Set or clear the rating (`MARK` field) on a Bitrix24 task.
 *
 * Bitrix24 REST: tasks.task.update (v3) — there is no dedicated rate method,
 * so the rating is just a field write on `MARK`.
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-update.html
 *
 * Field semantics from `tasks.task.getFields`:
 *   MARK: enum — "P" (positive) | "N" (negative) | null (no rating, default)
 *
 * The agent-friendly enum `positive | negative | none` is mapped to the
 * underlying P / N / null at the boundary so the LLM never has to know about
 * single-letter codes.
 */
const RATING_TO_MARK = {
  positive: 'P',
  negative: 'N',
  none: null,
} as const

export default defineMcpTool({
  name: 'bitrix24_rate_task',
  description:
    'Set or clear the rating on a Bitrix24 task — `positive` (👍, MARK=P), `negative` (👎, MARK=N), or `none` to remove an existing rating. Typically set by the task creator after the task is completed (status 5). Operates on one task at a time — for bulk ratings call `bitrix24_list_tasks` first, then loop (Bitrix24 caps ~2 req/sec). If the operator names a task in free text instead of an id, resolve it via `bitrix24_list_tasks` with a `%TITLE` filter first.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id to rate.'),
    rating: z
      .enum(['positive', 'negative', 'none'])
      .describe(
        'New rating. `positive` = thumbs-up (Bitrix24 MARK=P), `negative` = thumbs-down (MARK=N), `none` clears the rating back to unset (MARK=null).',
      ),
  },
  handler: async ({ taskId, rating }) => {
    try {
      const b24 = useBitrix24()
      const response = await b24.callMethod('tasks.task.update', {
        taskId,
        fields: { MARK: RATING_TO_MARK[rating] },
      })
      const [task] = extractTasks(response.getData()?.result)

      if (!task) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task ${taskId} rating set to ${rating}, but Bitrix24 returned no task body. Re-list to verify.`,
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                rated: true,
                id: task.id,
                title: task.title,
                rating,
                mark: RATING_TO_MARK[rating],
              },
              null,
              2,
            ),
          },
        ],
      }
    } catch (err) {
      throw toToolError(err, `Failed to rate Bitrix24 task ${taskId}`)
    }
  },
})
