import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { SingleTaskEnvelope } from '~/server/types/bitrix24'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV3 } from '~/server/utils/sdk-helpers'
import { extractTasks } from '~/server/utils/tasks'

/**
 * Updates a Bitrix24 task in place.
 *
 * Bitrix24 REST: tasks.task.update
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-update.html
 *
 * The REST method takes UPPERCASE field keys. We pass `fields` through
 * untouched so the agent has full reach into the field set without us
 * having to enumerate every option.
 */
export default defineMcpTool({
  name: 'bitrix24_update_task',
  description:
    'Update an existing Bitrix24 task. `fields` is an object of UPPERCASE Bitrix24 task field names (TITLE, DESCRIPTION, DEADLINE, RESPONSIBLE_ID, STATUS, PRIORITY, GROUP_ID, …). Only provide the fields you want to change. Returns the updated task summary.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id from `bitrix24_list_tasks` or `bitrix24_create_task`.'),
    fields: z
      .record(z.string(), z.unknown())
      .refine((f) => Object.keys(f).length > 0, { message: 'fields must be a non-empty object' })
      .describe(
        'Fields to change. Keys UPPERCASE: TITLE | DESCRIPTION | DEADLINE (ISO 8601) | RESPONSIBLE_ID (int) | STATUS (int) | PRIORITY ("0"|"1"|"2") | GROUP_ID (int) | ACCOMPLICES / AUDITORS (array of user ids — note these REPLACE the current set, fetch first if you want to add). Example: { "TITLE": "renamed", "DEADLINE": "2026-06-01T18:00:00+03:00", "ACCOMPLICES": [12, 47] }.',
      ),
  },
  handler: async ({ taskId, fields }) => {
    const b24 = useBitrix24()
    const result = await callV3<SingleTaskEnvelope>(
      b24,
      'tasks.task.update',
      { taskId, fields },
      `Failed to update Bitrix24 task ${taskId}`,
    )
    const [task] = extractTasks(result)

    if (!task) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Task ${taskId} updated, but Bitrix24 returned no task body. Re-list to verify the change landed.`,
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
            id: task.id,
            title: task.title,
            deadline: task.deadline ?? null,
            responsibleId: task.responsibleId ?? null,
            status: task.status ?? null,
          }),
        },
      ],
    }
  },
})
