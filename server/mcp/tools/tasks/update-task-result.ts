import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { TaskResultItemEnvelope } from '~/server/types/bitrix24'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV3 } from '~/server/utils/sdk-helpers'
import { toTaskResultShort } from '~/server/utils/task-results'

/**
 * Update the text of an existing Bitrix24 task result.
 *
 * Bitrix24 REST: tasks.task.result.update (v3)
 *   https://apidocs.bitrix24.com/api-reference/rest-v3/tasks/result/tasks-task-result-update.html
 *
 * Only the author of the result (or a portal admin) is allowed to edit it.
 * The endpoint accepts only `text`; status / authorship / timestamps are
 * managed by Bitrix24.
 */
export default defineMcpTool({
  name: 'b24_task_result_update',
  description:
    'Rewrite the text of an existing Bitrix24 task result. Only the result author (or a portal admin) is permitted to edit; otherwise Bitrix24 returns ACCESSDENIEDEXCEPTION. The resultId comes from `b24_task_result_add` or `b24_task_result_list` — do NOT pass the parent taskId here.',
  inputSchema: {
    resultId: z
      .number()
      .int()
      .positive()
      .describe('Result id (NOT the parent taskId). Get from `b24_task_result_list` or the response of `b24_task_result_add`.'),
    text: z
      .string()
      .min(1)
      .max(10000)
      .describe('New result text. Max 10000 chars (matches `b24_task_result_add`; oversized payloads are rejected at the schema layer). Replaces the previous text entirely; partial edits are not supported.'),
  },
  handler: async ({ resultId, text }) => {
    const b24 = useBitrix24()
    const result = await callV3<TaskResultItemEnvelope>(
      b24,
      'tasks.task.result.update',
      { id: resultId, fields: { text } },
      `Failed to update Bitrix24 task result ${resultId}`,
    )

    const short = toTaskResultShort(result?.item)
    if (!short) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Task result ${resultId} updated, but Bitrix24 returned no result body. Re-list with b24_task_result_list to verify the change landed.`,
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            updated: true,
            id: short.id,
            taskId: short.taskId,
            text: short.text,
            updatedAt: short.updatedAt,
          }),
        },
      ],
    }
  },
})
