import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { toToolError } from '~/server/utils/errors'
import { extractTasks } from '~/server/utils/tasks'

/**
 * Creates a Bitrix24 task.
 *
 * Bitrix24 REST: tasks.task.add
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-add.html
 *
 * The REST method expects UPPERCASE field keys (`TITLE`, `RESPONSIBLE_ID`, …).
 * We accept camelCase from the agent and translate.
 */
export default defineMcpTool({
  name: 'bitrix24_create_task',
  description:
    'Create a new Bitrix24 task. Requires a title and a responsibleId (Bitrix24 user id — call bitrix24_current_user first if you only have your own). Optional: description, deadline (ISO 8601 with timezone), groupId, priority. Returns the new task id and a short summary.',
  inputSchema: {
    title: z.string().min(1).max(255).describe('Task title — max 255 chars.'),
    responsibleId: z
      .number()
      .int()
      .positive()
      .describe('Bitrix24 user id of the assignee. Get it from `bitrix24_current_user` if it should be the operator themselves.'),
    description: z
      .string()
      .optional()
      .describe('Task body. BBCode by default; for plain text avoid square brackets that could be parsed as tags.'),
    deadline: z
      .string()
      .optional()
      .describe('Deadline as ISO 8601 with timezone, e.g. "2026-05-20T18:00:00+03:00". Omit for no deadline.'),
    groupId: z.number().int().nonnegative().optional().describe('Workgroup id. 0 / omitted = personal task.'),
    priority: z
      .enum(['0', '1', '2'])
      .optional()
      .describe('"0" = low, "1" = normal (default if omitted), "2" = important.'),
    accomplices: z
      .array(z.number().int().positive())
      .optional()
      .describe('User ids of co-doers. Omit for none.'),
    auditors: z
      .array(z.number().int().positive())
      .optional()
      .describe('User ids of auditors / observers. Omit for none.'),
  },
  handler: async ({ title, responsibleId, description, deadline, groupId, priority, accomplices, auditors }) => {
    try {
      const fields: Record<string, unknown> = {
        TITLE: title,
        RESPONSIBLE_ID: responsibleId,
      }
      if (description !== undefined) fields.DESCRIPTION = description
      if (deadline !== undefined) fields.DEADLINE = deadline
      if (groupId !== undefined) fields.GROUP_ID = groupId
      if (priority !== undefined) fields.PRIORITY = priority
      if (accomplices?.length) fields.ACCOMPLICES = accomplices
      if (auditors?.length) fields.AUDITORS = auditors

      const b24 = useBitrix24()
      const response = await b24.callMethod('tasks.task.add', { fields })
      const [task] = extractTasks(response.getData()?.result)

      if (!task) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Bitrix24 accepted the create-task call but returned no task body. The task was likely created — list tasks by RESPONSIBLE_ID to find it.',
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
                created: true,
                id: task.id,
                title: task.title,
                responsibleId: task.responsibleId ?? null,
                deadline: task.deadline ?? null,
              },
              null,
              2,
            ),
          },
        ],
      }
    } catch (err) {
      throw toToolError(err, 'Failed to create Bitrix24 task')
    }
  },
})
