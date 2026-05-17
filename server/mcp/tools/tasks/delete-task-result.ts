import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV3 } from '~/server/utils/sdk-helpers'

/**
 * Delete a Bitrix24 task result.
 *
 * Bitrix24 REST: tasks.task.result.delete (v3)
 *   https://apidocs.bitrix24.com/api-reference/rest-v3/tasks/result/tasks-task-result-delete.html
 *
 * Only the author of the result (or a portal admin) can delete it.
 * Destructive — there is no undo. The task itself is untouched; only the
 * result entry disappears.
 */
export default defineMcpTool({
  name: 'bitrix24_delete_task_result',
  description:
    'Delete a Bitrix24 task result. Destructive — there is no undo, but the task itself is not affected. Only the result author (or a portal admin) is allowed to delete it; other callers get ACCESSDENIEDEXCEPTION. The resultId comes from `bitrix24_list_task_results`.',
  inputSchema: {
    resultId: z
      .number()
      .int()
      .positive()
      .describe('Result id (NOT the parent taskId). Get from `bitrix24_list_task_results`.'),
  },
  handler: async ({ resultId }) => {
    const b24 = useBitrix24()
    // The endpoint's success envelope is `{ result: true }` — we don't need
    // the body, only that `callV3` didn't throw.
    await callV3<{ result?: boolean }>(
      b24,
      'tasks.task.result.delete',
      { id: resultId },
      `Failed to delete Bitrix24 task result ${resultId}`,
    )

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ deleted: true, resultId }),
        },
      ],
    }
  },
})
