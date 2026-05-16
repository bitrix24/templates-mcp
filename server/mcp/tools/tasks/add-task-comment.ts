import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { toToolError } from '~/server/utils/errors'

/**
 * Adds a comment to a Bitrix24 task.
 *
 * Bitrix24 REST: task.commentitem.add
 *   https://apidocs.bitrix24.com/api-reference/tasks/comment-item/task-comment-item-add.html
 *
 * Note: this REST method is documented as deprecated in favour of
 * `tasks.task.chat.message.send`, but it remains stable, well-supported on
 * webhook auth, and predictable. Migration is queued for a follow-up PR.
 */
export default defineMcpTool({
  name: 'bitrix24_add_task_comment',
  description:
    'Append a comment to an existing Bitrix24 task. The comment author defaults to the user behind the configured webhook; pass `authorId` only if you have permission to post on behalf of someone else (admin-only on most portals). Returns the new comment id.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id to comment on.'),
    text: z
      .string()
      .min(1)
      .describe(
        'Comment body. BBCode is rendered (e.g. [B]bold[/B], [URL=https://...]link[/URL]). For plain text, avoid square brackets that could be interpreted as tags.',
      ),
    authorId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('User id to post the comment as. Omit to use the webhook owner. Most portals reject this for non-admins.'),
  },
  handler: async ({ taskId, text, authorId }) => {
    try {
      const fields: Record<string, unknown> = { POST_MESSAGE: text }
      if (authorId !== undefined) fields.AUTHOR_ID = authorId

      const b24 = useBitrix24()
      const response = await b24.callMethod('task.commentitem.add', {
        TASKID: taskId,
        FIELDS: fields,
      })

      // task.commentitem.add returns { result: <commentId int>, time: {...} }
      const commentId = response.getData()?.result
      if (typeof commentId !== 'number' && typeof commentId !== 'string') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Comment on task ${taskId} accepted, but Bitrix24 returned no comment id.`,
            },
          ],
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ posted: true, taskId, commentId }, null, 2),
          },
        ],
      }
    } catch (err) {
      throw toToolError(err, `Failed to comment on Bitrix24 task ${taskId}`)
    }
  },
})
