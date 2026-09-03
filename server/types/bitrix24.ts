/**
 * Bitrix24 REST response shapes that we accept from the wire.
 *
 * Bitrix24 stringifies most numeric fields in the REST layer (issue #10
 * tracks normalising them to numbers at the boundary). Until that lands,
 * each `*Raw` interface mirrors the wire format as-is — strings where
 * Bitrix24 sends strings, optional where v3 may omit, etc.
 */

/**
 * The subset of `tasks.task.{add,get,update,start,…}` response fields
 * that the project consumes via `extractTasks` / `toTaskShort`.
 * Bitrix24 returns many more (50+); listing them all here would be
 * brittle, so we keep this narrow and let `extractTasks` cope with
 * stray fields.
 */
export interface BitrixTaskRaw {
  id?: number | string
  ID?: number | string
  title?: string
  TITLE?: string
  status?: string | number
  STATUS?: string | number
  deadline?: string | null
  DEADLINE?: string | null
  responsibleId?: string | number
  RESPONSIBLE_ID?: string | number
  createdDate?: string
  CREATED_DATE?: string
  priority?: string | number
  PRIORITY?: string | number
}

/** Envelope for single-task v3 endpoints (`tasks.task.add` / `.get` / `.update`). */
export interface SingleTaskEnvelope {
  task: BitrixTaskRaw
}

/** Envelope for list v3 endpoint (`tasks.task.list`). */
export interface TaskListEnvelope {
  tasks?: BitrixTaskRaw[]
  total?: number
}

/**
 * Bitrix24 checklist-item wire shape — v2 `task.checklistitem.{add,getlist}`
 * REST methods. Bitrix24 ships UPPER_SNAKE on the wire; we still tolerate
 * camelCase in case the SDK transforms responses for a future release. All
 * id fields can arrive stringified ("431") or numeric (0 for headings).
 */
export interface BitrixChecklistItemRaw {
  id?: number | string
  ID?: number | string
  taskId?: number | string
  TASK_ID?: number | string
  parentId?: number | string
  PARENT_ID?: number | string
  title?: string
  TITLE?: string
  sortIndex?: number | string
  SORT_INDEX?: number | string
  isComplete?: 'Y' | 'N' | boolean
  IS_COMPLETE?: 'Y' | 'N' | boolean
  isImportant?: 'Y' | 'N' | boolean
  IS_IMPORTANT?: 'Y' | 'N' | boolean
  createdBy?: number | string | null
  CREATED_BY?: number | string | null
  toggledBy?: number | string | null
  TOGGLED_BY?: number | string | null
  toggledDate?: string | null
  TOGGLED_DATE?: string | null
}

/**
 * Task-result wire shape — v3 `tasks.task.result.*`. A "result" is a piece
 * of free-form text the operator records as the answer / outcome of a task,
 * separately from the task body and comments. The full Bitrix24 response
 * also carries `fileIds` / `rights` — we don't surface those today.
 */
export interface BitrixTaskResultRaw {
  id?: number | string
  taskId?: number | string
  text?: string
  authorId?: number | string
  createdAt?: string | null
  updatedAt?: string | null
  status?: 'open' | 'closed' | string
  messageId?: number | string | null
}

/** Envelope for single-result v3 endpoints (`tasks.task.result.add` / `.update`). */
export interface TaskResultItemEnvelope {
  item: BitrixTaskResultRaw
}

/** Envelope for the list endpoint (`tasks.task.result.list`). */
export interface TaskResultListEnvelope {
  items?: BitrixTaskResultRaw[]
}

/**
 * Elapsed-time wire shape — returned by `task.elapseditem.getlist` (v2).
 * `add` returns only the new id (integer), `update` / `delete` return null,
 * so the projection (`toElapsedTimeShort`) only needs this for the list
 * endpoint. Bitrix24 ships UPPER_SNAKE on the wire; we tolerate camelCase
 * in case the SDK transforms responses for a future release. All id and
 * duration fields can arrive stringified.
 *
 * `MINUTES` and `SOURCE` are listed here as optional for type honesty —
 * Bitrix24 does ship them in the response, but we deliberately drop both
 * from the projection (`MINUTES = SECONDS / 60` is derivable and surfacing
 * both invites contradictory values; `SOURCE` is a Bitrix24-internal enum
 * for the entry origin — manual / timer / integration — with no agent
 * value today). Listing them in the type prevents `noUncheckedIndexedAccess`
 * surprises if a future projection wants them.
 */
export interface BitrixElapsedTimeRaw {
  id?: number | string
  ID?: number | string
  taskId?: number | string
  TASK_ID?: number | string
  userId?: number | string | null
  USER_ID?: number | string | null
  commentText?: string
  COMMENT_TEXT?: string
  seconds?: number | string
  SECONDS?: number | string
  /** Derived field shipped by Bitrix24 (SECONDS / 60) — not projected. */
  minutes?: number | string
  MINUTES?: number | string
  /** Bitrix24-internal entry-origin enum — not projected. */
  source?: string
  SOURCE?: string
  createdDate?: string | null
  CREATED_DATE?: string | null
  dateStart?: string | null
  DATE_START?: string | null
  dateStop?: string | null
  DATE_STOP?: string | null
}

/**
 * Task-comment wire shape — v2 `task.commentitem.{get,getlist}`. Bitrix24
 * ships UPPER_SNAKE on the wire; camelCase keys are tolerated in case the
 * SDK starts transforming responses.
 *
 * Notable wire facts, verified against a live portal (2026-09-02):
 *   - `POST_MESSAGE` carries the BBCode body; `POST_MESSAGE_HTML` is `null`
 *     for every comment written through the UI (Bitrix24 only fills it for
 *     comments posted with an explicit HTML payload), so the projection
 *     treats `POST_MESSAGE` as the canonical text.
 *   - `AUTHOR_NAME` is shipped alongside `AUTHOR_ID`, so reading "who said
 *     what" needs no extra `user.get` round-trip.
 *   - `AUTHOR_EMAIL` is often an empty string.
 *   - The item does NOT echo the task id — the caller owns it.
 *   - Bitrix24's own lifecycle notes ("Задача завершена.", "Крайний срок
 *     изменен на: …") arrive as ordinary comments authored by the user who
 *     triggered them; the REST layer exposes no flag to tell them apart.
 */
export interface BitrixTaskCommentRaw {
  id?: number | string
  ID?: number | string
  authorId?: number | string | null
  AUTHOR_ID?: number | string | null
  authorName?: string | null
  AUTHOR_NAME?: string | null
  authorEmail?: string | null
  AUTHOR_EMAIL?: string | null
  postDate?: string | null
  POST_DATE?: string | null
  postMessage?: string | null
  POST_MESSAGE?: string | null
  postMessageHtml?: string | null
  POST_MESSAGE_HTML?: string | null
}

/**
 * Task-chat message wire shape — v2 `im.dialog.messages.get` with
 * `DIALOG_ID: "chat<chatId>"`. Bitrix24 keeps task comments in two different
 * places depending on when the task was created:
 *
 *   - legacy tasks carry a `forumTopicId` and their comments live in the
 *     forum, readable via `task.commentitem.getlist`;
 *   - tasks created after the portal moved to the chat-based task card carry
 *     a `chatId` and their comments are chat messages — `commentitem.getlist`
 *     returns an empty array for them, with no error.
 *
 * Verified on a live portal (2026-09-03): a task created that day had
 * `forumTopicId: null` / `chatId: 6479`, and two comments posted through
 * `task.commentitem.add` came back only from the chat. The legacy task's own
 * chat carried exactly two system notices telling the reader that older
 * comments stay in the forum — so both sources have to be read and merged.
 *
 * Field names are snake_case here (the `im.*` family differs from the rest of
 * the REST API, which is UPPER_SNAKE on the wire and camelCase on v3).
 * `author_id: 0` marks a system message — the one reliable system/human
 * signal in either storage.
 */
export interface BitrixChatMessageRaw {
  id?: number | string
  chat_id?: number | string
  author_id?: number | string
  date?: string | null
  text?: string | null
  params?: Record<string, unknown>
}

/** A user entry from the `users` array of an `im.dialog.messages.get` response. */
export interface BitrixChatUserRaw {
  id?: number | string
  name?: string | null
  first_name?: string | null
  last_name?: string | null
}

/** Envelope for `im.dialog.messages.get`. */
export interface ChatMessagesEnvelope {
  chat_id?: number | string
  messages?: BitrixChatMessageRaw[]
  users?: BitrixChatUserRaw[]
}
