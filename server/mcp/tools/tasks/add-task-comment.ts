import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'

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
  name: 'b24_task_comment_add',
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
    const fields: Record<string, unknown> = { POST_MESSAGE: text }
    if (authorId !== undefined) fields.AUTHOR_ID = authorId

    const b24 = useBitrix24Tenant()
    // task.commentitem.add is a v2 method (the v3 replacement
    // tasks.task.chat.message.send is queued for a separate migration PR).
    // The result payload is a bare commentId — number or string per portal.
    const commentId = await callV2<number | string>(
      b24,
      'task.commentitem.add',
      { TASKID: taskId, FIELDS: fields },
      `Failed to comment on Bitrix24 task ${taskId}`,
    )

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
          text: JSON.stringify({ posted: true, taskId, commentId }),
        },
      ],
    }
  },
})
