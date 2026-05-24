import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { SingleTaskEnvelope } from '~/server/types/bitrix24'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'
import { extractTasks } from '~/server/utils/tasks'

/**
 * Creates a Bitrix24 task.
 *
 * Bitrix24 REST: tasks.task.add (classic / v2 transport)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-add.html
 *
 * This is the classic `tasks.task.*` API, served on the v2 transport
 * (`callV2`), NOT rest-v3 — the v3 `TaskDto` rejects these UPPERCASE keys with
 * `UNKNOWNDTOPROPERTYEXCEPTION`. The method expects UPPERCASE field keys
 * (`TITLE`, `RESPONSIBLE_ID`, …); we accept camelCase from the agent and
 * translate.
 *
 * NOTE: this tool does not set `CREATED_BY`, so Bitrix24 attributes the task
 * to the webhook user — which may not be the person requesting it. Controlled
 * creator attribution is tracked in issue #125.
 */
export default defineMcpTool({
  name: 'b24_task_create',
  description:
    'Create a new Bitrix24 task. Requires a title and a responsibleId (Bitrix24 user id — call b24_user_me first if you only have your own). Optional: description, deadline (ISO 8601 with timezone), groupId, priority. Returns the new task id and a short summary. Note: the task creator is not set here, so Bitrix24 records the webhook user as creator — this may differ from the person actually requesting the task.',
  inputSchema: {
    title: z.string().min(1).max(255).describe('Task title — max 255 chars.'),
    responsibleId: z
      .number()
      .int()
      .positive()
      .describe('Bitrix24 user id of the assignee. Get it from `b24_user_me` if it should be the operator themselves.'),
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
    const result = await callV2<SingleTaskEnvelope>(
      b24,
      'tasks.task.add',
      { fields },
      'Failed to create Bitrix24 task',
    )
    const [task] = extractTasks(result)

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
          text: JSON.stringify({
            created: true,
            id: task.id,
            title: task.title,
            responsibleId: task.responsibleId ?? null,
            deadline: task.deadline ?? null,
          }),
        },
      ],
    }
  },
})
