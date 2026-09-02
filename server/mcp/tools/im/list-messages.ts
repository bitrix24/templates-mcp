import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'
import { buildImUserNameMap, toImMessageShort, type ImMessageShort } from '~/server/utils/im'
import type { ImDialogMessagesEnvelope } from '~/server/types/bitrix24'

/**
 * Read recent messages from one Bitrix24 Messenger dialog — a personal
 * conversation, a group chat, or a task's discussion chat.
 *
 * Bitrix24 REST: im.dialog.messages.get (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/im/im-dialog-messages-get.html
 *
 * `dialogId` shapes: a bare numeric user id (`"33"`) for a personal
 * dialog, `"chat<id>"` for a group / task chat, `"sg<id>"` for a workgroup
 * chat. Get it from `b24_im_dialog_list` (its `dialogId`) or from
 * `b24_task_get`'s `chatId` (prefix it with `chat`, e.g. `chatId: 5869` ->
 * `"chat5869"`).
 */
export default defineMcpTool({
  name: 'b24_im_message_list',
  description:
    'Read recent messages from one Bitrix24 Messenger dialog (personal DM, group chat, or a task\'s discussion chat), newest first. `dialogId` is a bare user id for a personal dialog (from `b24_im_dialog_list`), `"chat<id>"` for a group / task chat — for a task, build it from `b24_task_get`\'s `chatId` (e.g. `chatId: 5869` -> `dialogId: "chat5869"`). Each message carries `authorId` **and** `authorName` (resolved from the response\'s embedded user list — no extra `b24_user_find` call needed). To check whether the operator was @-mentioned, match `text` against `[USER=<id>]Name[/USER]` BBCode.',
  inputSchema: {
    dialogId: z
      .string()
      .min(1)
      .describe('Dialog id: bare user id ("33") for a personal DM, "chat<id>" for a group/task chat, "sg<id>" for a workgroup.'),
    lastId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Message id to page backwards from — pass the smallest `id` seen so far to load older messages.'),
    limit: z.number().int().positive().max(200).optional().describe('Max messages to return. Omit for Bitrix24\'s own default.'),
  },
  handler: async ({ dialogId, lastId, limit }) => {
    const params: Record<string, unknown> = { DIALOG_ID: dialogId }
    if (lastId !== undefined) params.LAST_ID = lastId
    if (limit !== undefined) params.LIMIT = limit

    const result = await callV2<ImDialogMessagesEnvelope>(
      useBitrix24Tenant(),
      'im.dialog.messages.get',
      params,
      `Failed to read Bitrix24 dialog ${dialogId}`,
    )

    const userNames = buildImUserNameMap(result?.users)
    const messages: ImMessageShort[] = Array.isArray(result?.messages)
      ? result.messages
          .map((m) => toImMessageShort(m, userNames))
          .filter((m): m is ImMessageShort => m !== null)
      : []

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            dialogId,
            returned: messages.length,
            messages,
          }),
        },
      ],
    }
  },
})
