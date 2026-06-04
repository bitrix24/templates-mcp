import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { SingleTaskEnvelope } from '~/server/types/bitrix24'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'
import { extractTasks } from '~/server/utils/tasks'

/**
 * Updates a Bitrix24 task in place.
 *
 * Bitrix24 REST: tasks.task.update (classic / v2 transport)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-update.html
 *
 * This is the classic `tasks.task.*` API, served on the v2 transport
 * (`callV2`), NOT rest-v3 — the v3 `TaskDto` rejects these UPPERCASE keys with
 * `UNKNOWNDTOPROPERTYEXCEPTION`. The method takes UPPERCASE field keys; we pass
 * `fields` through untouched so the agent has full reach into the field set
 * without us having to enumerate every option.
 */
export default defineMcpTool({
  name: 'b24_task_update',
  description:
    'Update an existing Bitrix24 task. `fields` is an object of UPPERCASE Bitrix24 task field names (TITLE, DESCRIPTION, DEADLINE, RESPONSIBLE_ID, STATUS, PRIORITY, GROUP_ID, …). Only provide the fields you want to change. Returns the updated task summary.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id from `b24_task_list` or `b24_task_create`.'),
    fields: z
      .record(
        // Constrain keys to the Bitrix24 UPPER_SNAKE_CASE field shape so an LLM
        // can't smuggle arbitrary strings into the REST payload. Every Bitrix24
        // task field — built-in and user-defined (UF_*) — matches this.
        z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'field keys must be UPPER_SNAKE_CASE (e.g. TITLE, RESPONSIBLE_ID)'),
        z.unknown(),
      )
      .refine((f) => Object.keys(f).length > 0, { message: 'fields must be a non-empty object' })
      .describe(
        'Fields to change. Keys UPPERCASE: TITLE | DESCRIPTION | DEADLINE (ISO 8601) | RESPONSIBLE_ID (int) | STATUS (int) | PRIORITY ("0"|"1"|"2") | GROUP_ID (int) | ACCOMPLICES / AUDITORS (array of user ids — note these REPLACE the current set, fetch first if you want to add). Example: { "TITLE": "renamed", "DEADLINE": "2026-06-01T18:00:00+03:00", "ACCOMPLICES": [12, 47] }.',
      ),
  },
  handler: async ({ taskId, fields }) => {
    const b24 = useBitrix24Tenant()
    const result = await callV2<SingleTaskEnvelope>(
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
