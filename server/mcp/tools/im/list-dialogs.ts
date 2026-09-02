import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'
import { toImDialogShort, type ImDialogShort } from '~/server/utils/im'
import type { ImRecentListEnvelope } from '~/server/types/bitrix24'

/**
 * List the operator's recent Bitrix24 Messenger dialogs — personal direct
 * messages, group chats, workgroup chats, and task discussion chats — with
 * unread state. This is the polling primitive for "did anyone message me":
 * check `unread` / `unreadCount` on each row, then read the full thread
 * with `b24_im_message_list { dialogId }`.
 *
 * Bitrix24 REST: im.recent.list (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/chats/im-recent-list.html
 *
 * Verified against a live portal (2026-09-02): the older `im.recent.get`
 * silently ignores `LIMIT` (always returns everything) — `im.recent.list`
 * is the one that actually paginates (`LIMIT` / `OFFSET`, envelope carries
 * `items` + `hasMore`).
 *
 * NOTE: like every `im.*` call, this reads dialogs belonging to whichever
 * user owns the webhook / OAuth token — there is no way to read another
 * user's private messages through this API.
 */
export default defineMcpTool({
  name: 'b24_im_dialog_list',
  description:
    'List the webhook owner\'s recent Bitrix24 Messenger dialogs, most recently active first — personal direct messages (`type: "user"`), group chats, and task discussion chats (`type: "chat"`) all in one list. Each row carries `unread` / `unreadCount` and a preview of the last message (`lastMessageText`, `lastMessageAuthorId`) — use those to detect "someone wrote to me" without opening every dialog. To read the full thread of one dialog, pass its `dialogId` to `b24_im_message_list`. Only sees dialogs belonging to the webhook/OAuth identity — it cannot read another person\'s private messages.',
  inputSchema: {
    limit: z.number().int().positive().max(50).optional().describe('Max dialogs to return. Default 20 (Bitrix24 default); max 50.'),
    offset: z.number().int().nonnegative().optional().describe('Pagination offset. Default 0 — combine with `hasMore` in the response to page further.'),
  },
  handler: async ({ limit, offset }) => {
    const params: Record<string, unknown> = {}
    if (limit !== undefined) params.LIMIT = limit
    if (offset !== undefined) params.OFFSET = offset

    const result = await callV2<ImRecentListEnvelope>(
      useBitrix24Tenant(),
      'im.recent.list',
      params,
      'Failed to list Bitrix24 Messenger dialogs',
    )

    const dialogs: ImDialogShort[] = Array.isArray(result?.items)
      ? result.items.map(toImDialogShort).filter((d): d is ImDialogShort => d !== null)
      : []

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            returned: dialogs.length,
            hasMore: result?.hasMore ?? false,
            dialogs,
          }),
        },
      ],
    }
  },
})
