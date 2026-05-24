import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { TaskResultItemEnvelope } from '~/server/types/bitrix24'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV3 } from '~/server/utils/sdk-helpers'
import { toTaskResultShort } from '~/server/utils/task-results'

/**
 * Record a "result" on a Bitrix24 task.
 *
 * A Bitrix24 task **result** is free-form text the operator captures as the
 * outcome or answer to the task — kept separately from the task body and
 * from comments. Operators typically write one when they close a task and
 * want a permanent, surfaced summary of what was actually delivered.
 *
 * Bitrix24 REST: tasks.task.result.add (v3)
 *   https://apidocs.bitrix24.com/api-reference/rest-v3/tasks/result/tasks-task-result-add.html
 */
export default defineMcpTool({
  name: 'b24_task_result_add',
  description:
    'Record a RESULT on a Bitrix24 task — a free-form text capturing the outcome of the work, kept separately from comments and the task body. Useful for "what did we actually deliver" entries written at completion time. Returns the new result id. Multiple results per task are allowed; use `b24_task_result_list` to read them.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id to attach the result to.'),
    text: z
      .string()
      .min(1)
      .max(10000)
      .describe(
        'Result text. Required. Max 10000 chars (oversized payloads are rejected at the schema layer to protect the MCP from memory-DoS). BBCode is rendered the same as in task descriptions and comments. Keep it concise — this is the headline outcome, not a chat log.',
      ),
  },
  handler: async ({ taskId, text }) => {
    const b24 = useBitrix24()
    const result = await callV3<TaskResultItemEnvelope>(
      b24,
      'tasks.task.result.add',
      { fields: { taskId, text } },
      `Failed to add result to Bitrix24 task ${taskId}`,
    )

    const short = toTaskResultShort(result?.item)
    if (!short) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Result accepted on task ${taskId}, but Bitrix24 returned no result body. Re-list with b24_task_result_list to find it.`,
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            added: true,
            id: short.id,
            taskId: short.taskId,
            text: short.text,
            authorId: short.authorId,
            createdAt: short.createdAt,
            updatedAt: short.updatedAt,
            status: short.status,
            messageId: short.messageId,
          }),
        },
      ],
    }
  },
})
