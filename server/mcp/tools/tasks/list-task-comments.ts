import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { ChatMessagesEnvelope, SingleTaskEnvelope } from '~/server/types/bitrix24'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'
import {
  chatUserNames,
  toChatCommentShort,
  toTaskCommentShort,
  type TaskCommentShort,
} from '~/server/utils/task-comments'
import { toNumber } from '~/server/utils/wire-coerce'

/**
 * Read the comment thread of a Bitrix24 task.
 *
 * **A task's comments live in one of two places, and which one depends on the
 * task's age.** This is the single most important fact about this endpoint
 * family, and getting it wrong produces a silent, confident "no comments":
 *
 *   - **Legacy tasks** carry a `forumTopicId`; their comments are forum posts,
 *     read with `task.commentitem.getlist` (v2).
 *   - **Tasks created after the portal moved to the chat-based task card**
 *     carry a `chatId` and their comments are chat messages, read with
 *     `im.dialog.messages.get` (v2, `DIALOG_ID: "chat<chatId>"`).
 *     `task.commentitem.getlist` returns `[]` for these — no error, no hint.
 *
 * Verified on a live portal (2026-09-03): a task created that day reported
 * `forumTopicId: null` / `chatId: 6479`; two comments posted through
 * `b24_task_comment_add` were invisible to `commentitem.getlist` and present
 * in the chat. Meanwhile a 2025 task's own chat contained exactly two system
 * notices — "Это новый чат задачи…" and one telling the reader that earlier
 * comments stay in the forum. So a task that predates the migration can hold
 * comments in BOTH stores, and the tool reads both and merges them.
 *
 * (This also settles the open question in the upstream issue about task-chat
 * reads: `tasks.task.chat.message.list` answers with an empty body on webhook
 * auth, but `im.dialog.messages.get` works and needs only the `im` scope.)
 *
 * `author_id: 0` on a chat message is Bitrix24's system marker — the only
 * dependable system-vs-human signal in either store. Forum rows have no
 * equivalent, so `isSystem: false` on a `source: "forum"` row means
 * "unknown", not "definitely a person".
 *
 * Wire constraints for the two list calls:
 *   - `task.commentitem.getlist` accepts `TASKID` and nothing else. `ORDER`
 *     or `FILTER` fail the whole call with `ERROR_CORE` /
 *     `TASKS_ERROR_EXCEPTION_#8 … ACTION_FAILED_TO_BE_PROCESSED`.
 *   - `im.dialog.messages.get` returns newest-first, pages backwards through
 *     `LAST_ID`, and ships a `users` array so names come for free.
 *
 * Ordering, author filtering, the system filter and paging are therefore all
 * applied locally over the merged thread. Comment bodies are returned in
 * full: never truncated, never summarised.
 */

/** Chat page size. Bitrix24 caps `im.dialog.messages.get` at 200 per call. */
const CHAT_PAGE = 200
/** How many chat pages to walk before giving up and saying so. */
const CHAT_MAX_PAGES = 5

export default defineMcpTool({
  name: 'b24_task_comment_list',
  description:
    'Read the comment thread on a Bitrix24 task — who wrote what, and when. Returns every comment in full (body verbatim, never truncated) with authorId + authorName, so attribution is explicit without a second lookup. IMPORTANT: Bitrix24 stores task comments in two places — the task chat for tasks created since the portal switched to the chat-based task card, and the old forum for older tasks — and this tool reads BOTH and merges them, so you get the whole thread either way; each comment says which store it came from in `source`. Default order is oldest-first, i.e. the thread reads as a conversation; pass order: "desc" for newest-first. Narrow to one person with `authorId` (get the id from `b24_user_find`), and bound a long thread with `limit` / `offset` — those drop whole comments, they never shorten one. Bitrix24 mixes its own lifecycle notes into the thread ("приостановил выполнение задачи", "Задача завершена."); chat-side ones are detected reliably and hidden by default (pass includeSystem: true to see them), but forum-side ones cannot be told apart from human comments by the API, so a `source: "forum"` comment with `isSystem: false` may still be a system note — judge by the text before quoting it as something a person said. Also returns an `authors` roll-up (id, name, comment count). Use `b24_task_comment_add` to write.',
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id to read comments from, e.g. from `b24_task_list`.'),
    order: z
      .enum(['asc', 'desc'])
      .optional()
      .describe(
        'Sort by post date: "asc" (default) reads oldest-first like a conversation; "desc" puts the latest comment first. Applied locally — neither underlying endpoint sorts on request.',
      ),
    authorId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only comments written by this user id. Omit for the whole thread. Applied locally.'),
    includeSystem: z
      .boolean()
      .optional()
      .describe(
        'Include Bitrix24-generated entries that the API marks as system (chat messages with author id 0 — lifecycle notes, "это новый чат задачи" boilerplate). Default false: they are hidden and counted in `systemHidden`. Note this only reaches system entries the API actually flags — forum-side lifecycle notes are indistinguishable from human comments and always pass through.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe(
        'Max number of comments to return after ordering and filtering. Omit to return the ENTIRE thread (the default — nothing is dropped). Comments are never individually truncated.',
      ),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Skip this many comments after ordering / filtering. Default 0. Use with `limit` to page a long thread.'),
  },
  handler: async ({ taskId, order, authorId, includeSystem, limit, offset }) => {
    const b24 = useBitrix24Tenant()

    // Which stores does this task have? `chatId` / `forumTopicId` are only
    // returned when selected. tasks.task.get is served on the classic
    // transport here (verified live) — the v3 DTO has no chat id at all.
    const meta = await callV2<SingleTaskEnvelope & { task?: Record<string, unknown> }>(
      b24,
      'tasks.task.get',
      { taskId, select: ['ID', 'CHAT_ID', 'FORUM_TOPIC_ID'] },
      `Failed to read Bitrix24 task ${taskId} before listing its comments`,
    )
    const chatId = toNumber((meta?.task as Record<string, unknown> | undefined)?.chatId)

    // Legacy forum store. Asked for unconditionally: a task that predates the
    // chat migration keeps its old comments here even though it also has a
    // chat, and the call is cheap (TASKID is the only accepted param).
    const forumData = await callV2<unknown[] | { result?: unknown[] }>(
      b24,
      'task.commentitem.getlist',
      { TASKID: taskId },
      `Failed to list forum comments on Bitrix24 task ${taskId}`,
    )
    const forumRows: unknown[] = Array.isArray(forumData)
      ? forumData
      : Array.isArray((forumData as { result?: unknown[] })?.result)
        ? ((forumData as { result?: unknown[] }).result ?? [])
        : []

    const all: TaskCommentShort[] = forumRows
      .map((row) => toTaskCommentShort(row, taskId))
      .filter((c): c is TaskCommentShort => c !== null)

    // Chat store. Newest-first, walked backwards via LAST_ID.
    let chatTruncated = false
    if (chatId !== null && chatId > 0) {
      let lastId: number | undefined
      for (let page = 0; page < CHAT_MAX_PAGES; page++) {
        const params: Record<string, unknown> = { DIALOG_ID: `chat${chatId}`, LIMIT: CHAT_PAGE }
        if (lastId !== undefined) params.LAST_ID = lastId
        const chat = await callV2<ChatMessagesEnvelope>(
          b24,
          'im.dialog.messages.get',
          params,
          `Failed to read the task chat of Bitrix24 task ${taskId}`,
        )
        const messages = Array.isArray(chat?.messages) ? chat.messages : []
        if (messages.length === 0) break

        const names = chatUserNames(chat?.users)
        for (const message of messages) {
          const projected = toChatCommentShort(message, taskId, names)
          if (projected) all.push(projected)
        }

        // A short page means we reached the beginning of the chat.
        if (messages.length < CHAT_PAGE) break
        const oldest = messages
          .map((m) => toNumber(m.id))
          .filter((id): id is number => id !== null)
          .reduce<number | null>((min, id) => (min === null || id < min ? id : min), null)
        if (oldest === null) break
        lastId = oldest
        // Ran out of pages with a full last page — the thread continues.
        if (page === CHAT_MAX_PAGES - 1) chatTruncated = true
      }
    }

    // Author roll-up covers the WHOLE thread, before filtering or paging — it
    // answers "who is in this conversation", which a filtered slice cannot.
    const authorCounts = new Map<string, { id: number | null, name: string | null, comments: number }>()
    for (const c of all) {
      if (c.isSystem) continue
      const key = `${c.authorId ?? 'null'}|${c.authorName ?? ''}`
      const seen = authorCounts.get(key)
      if (seen) seen.comments += 1
      else authorCounts.set(key, { id: c.authorId, name: c.authorName, comments: 1 })
    }

    const systemHidden = includeSystem === true ? 0 : all.filter((c) => c.isSystem).length
    const visible = includeSystem === true ? all : all.filter((c) => !c.isSystem)
    const filtered = authorId === undefined ? visible : visible.filter((c) => c.authorId === authorId)

    // Sort explicitly: the two stores arrive in different orders (forum
    // ascending, chat descending), so a merged thread is unordered until we
    // say otherwise. Fall back to id when a date is missing on either side.
    const sorted = [...filtered].sort((a, b) => {
      const byDate = (a.postDate ?? '').localeCompare(b.postDate ?? '')
      const delta = byDate !== 0 ? byDate : a.id - b.id
      return order === 'desc' ? -delta : delta
    })

    const from = offset ?? 0
    const page = limit === undefined ? sorted.slice(from) : sorted.slice(from, from + limit)

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            taskId,
            // `total` counts everything both stores returned; `matched` is
            // after the system + author filters; `returned` after paging. The
            // agent can tell "no comments" from "filtered everything out",
            // and knows whether more pages exist.
            total: all.length,
            matched: filtered.length,
            returned: page.length,
            offset: from,
            systemHidden,
            sources: {
              forum: all.filter((c) => c.source === 'forum').length,
              chat: all.filter((c) => c.source === 'chat').length,
            },
            // Only set when the chat page budget ran out — the thread has more
            // history than was read, so re-ask with a narrower need.
            ...(chatTruncated ? { chatTruncated: true } : {}),
            authors: [...authorCounts.values()],
            comments: page,
          }),
        },
      ],
    }
  },
})
