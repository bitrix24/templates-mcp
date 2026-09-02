import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV3 } from '~/server/utils/sdk-helpers'

/**
 * Fetch a single Bitrix24 task by id, including its linked chat id.
 *
 * Bitrix24 REST: tasks.task.get (v3 — no v2 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-get.html
 *
 * On portals using the newer Task Chat UI, `chatId` is the bridge to
 * `b24_im_message_list` — a task's discussion now lives in its linked chat
 * (`task.commentitem.*` returns empty there; see `b24_task_comment_list`).
 *
 * Verified against a live portal (2026-09-02) — three things the older v2
 * API and this v3 method do NOT share, despite both being "tasks.task.*":
 *   - the request param is `id`, not `taskId` (v3 TaskDto validation rejects
 *     `taskId` with "Обязательное поле `id` не указано")
 *   - the response root key is `item`, not `task`
 *   - nested-only fields: `responsible.id` (flat `responsibleId` is silently
 *     dropped, no error) and `chat.id`. `createdDate` / `createdBy` are not
 *     TaskDto fields at all ("Неизвестное поле … для сущности `TaskDto`") —
 *     omitted from `select` entirely rather than guessed at.
 * `status` here is v3's semantic string (`"pending"`, …), NOT the numeric
 * v2 status code `b24_task_list` returns for the same task — don't compare
 * the two directly.
 */

/** Subset of the REST response we surface back to the agent. */
interface TaskGetResponse {
  item: {
    id?: number | string
    title?: string
    status?: string
    deadline?: string | null
    responsible?: { id?: number | string }
    priority?: string | number
    chat?: { id?: number | string }
  }
}

export default defineMcpTool({
  name: 'b24_task_get',
  description:
    'Fetch a single Bitrix24 task by id — title, status, deadline, responsible, priority, and the id of its linked discussion chat (`chatId`). `status` is a semantic string (e.g. `"pending"`) — NOT the numeric code `b24_task_list` returns for the same task, so don\'t compare the two directly. Pass `chatId` as `"chat<id>"` to `b24_im_message_list` to read the task\'s comment/discussion thread (the old `b24_task_comment_list` reads a separate, often-empty legacy store on portals that migrated to the chat-based Task Card).',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id from `b24_task_list` or `b24_task_create`.'),
  },
  handler: async ({ taskId }) => {
    const b24 = useBitrix24Tenant()
    const result = await callV3<TaskGetResponse>(
      b24,
      'tasks.task.get',
      // NB: the wire param is `id`, not `taskId` — see the file-level note.
      { id: taskId, select: ['id', 'title', 'status', 'deadline', 'responsible.id', 'priority', 'chat.id'] },
      `Failed to fetch Bitrix24 task ${taskId}`,
    )

    if (!result?.item) {
      return {
        content: [{ type: 'text' as const, text: `Task ${taskId} not found.` }],
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            id: result.item.id ?? taskId,
            title: result.item.title ?? null,
            status: result.item.status ?? null,
            deadline: result.item.deadline ?? null,
            responsibleId: result.item.responsible?.id ?? null,
            priority: result.item.priority ?? null,
            chatId: result.item.chat?.id ?? null,
          }),
        },
      ],
    }
  },
})
