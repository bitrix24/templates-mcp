import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'
import { toTaskCommentShort, type TaskCommentShort } from '~/server/utils/task-comments'
import type { BitrixTaskCommentRaw } from '~/server/types/bitrix24'

/**
 * Lists comments on a Bitrix24 task — the read counterpart to
 * `b24_task_comment_add`.
 *
 * Bitrix24 REST: task.commentitem.getlist (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/tasks/comment-item/task-comment-item-get-list.html
 *
 * Note: like `task.commentitem.add`, this REST method is documented as
 * deprecated in favour of `tasks.task.chat.message.send` / the chat-message
 * read endpoints, but it remains stable and predictable on webhook auth.
 * Migration is queued for a follow-up alongside the `.add` tool.
 */

const SORT_FIELDS = ['id', 'postDate', 'authorId'] as const

const CAMEL_TO_WIRE: Record<(typeof SORT_FIELDS)[number], string> = {
  id: 'ID',
  postDate: 'POST_DATE',
  authorId: 'AUTHOR_ID',
}

export default defineMcpTool({
  name: 'b24_task_comment_list',
  description:
    'List the comments on a Bitrix24 task, newest first by default. Use this to catch up on a task\'s discussion or to check whether the operator was @-mentioned — Bitrix24 renders a mention inside `text` as `[USER=<id>]Name[/USER]` BBCode, so match on that pattern (or the operator\'s name) rather than expecting a dedicated "mentioned" field. Each comment carries `authorId` / `authorName` and `postDate` for a timeline read. **On portals that migrated to the chat-based Task Card, this returns an empty list even when the task has an active discussion** — comments moved into a linked chat. If `returned: 0` looks surprising, call `b24_task_get` for the task\'s `chatId` and read the discussion via `b24_im_message_list` instead.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id to read comments of.'),
    order: z
      .object({
        field: z
          .enum(SORT_FIELDS)
          .describe('Sort field. `postDate` matches "when written"; `id` ascending matches insertion order.'),
        direction: z.enum(['asc', 'desc']).describe('Sort direction.'),
      })
      .optional()
      .describe('Sort order. Default `{ field: "postDate", direction: "desc" }` — newest first.'),
  },
  handler: async ({ taskId, order }) => {
    const sort = order ?? { field: 'postDate' as const, direction: 'desc' as const }
    const params = { TASKID: taskId, ORDER: { [CAMEL_TO_WIRE[sort.field]]: sort.direction.toUpperCase() } }

    // `task.commentitem.getlist` returns `{ result: [...] }` — a bare array
    // of comment items (same envelope shape as `task.checklistitem.getlist`).
    const raw = await callV2<BitrixTaskCommentRaw[]>(
      useBitrix24Tenant(),
      'task.commentitem.getlist',
      params,
      `Failed to list Bitrix24 comments for task ${taskId}`,
    )

    const comments: TaskCommentShort[] = Array.isArray(raw)
      ? raw.map(toTaskCommentShort).filter((c): c is TaskCommentShort => c !== null)
      : []

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            taskId,
            returned: comments.length,
            comments,
          }),
        },
      ],
    }
  },
})
