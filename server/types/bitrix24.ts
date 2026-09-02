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
 * Task-comment wire shape — v2 `task.commentitem.{add,getlist}`. Bitrix24
 * ships UPPER_SNAKE on the wire; we tolerate camelCase in case the SDK
 * transforms responses for a future release. `AUTHOR_NAME` is a display
 * convenience Bitrix24 adds on read (not accepted on `.add`), so it's
 * optional here. Mention markup inside `POST_MESSAGE` uses Bitrix24's
 * `[USER=<id>]Name[/USER]` BBCode tag — callers looking for "was I
 * tagged?" match on that pattern, not on a dedicated field (Bitrix24
 * doesn't expose one).
 */
export interface BitrixTaskCommentRaw {
  id?: number | string
  ID?: number | string
  taskId?: number | string
  TASK_ID?: number | string
  authorId?: number | string
  AUTHOR_ID?: number | string
  authorName?: string
  AUTHOR_NAME?: string
  postMessage?: string
  POST_MESSAGE?: string
  postDate?: string | null
  POST_DATE?: string | null
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
 * Bitrix24 IM (messenger) wire shapes — `im.recent.get` / `im.dialog.messages.get`.
 * Unlike `tasks.*` / `task.*`, the `im` module ships a SINGLE consistent
 * `snake_case` casing on the wire (no UPPER_SNAKE, no camelCase variants) —
 * these types intentionally do NOT use the `pick(lower, upper)` dual-casing
 * helper from `wire-coerce.ts`; access fields directly.
 */

/** One row of `im.recent.get` — a dialog (personal, group chat, or task chat). */
export interface BitrixImRecentRaw {
  /** Dialog id to pass as `DIALOG_ID` to `im.dialog.messages.get` — numeric
   *  user id for a personal dialog, `"chat<id>"` for a group / task chat. */
  id?: number | string
  chat_id?: number
  /** `"user"` = personal dialog; `"chat"` = group chat, task chat, or workgroup. */
  type?: string
  title?: string
  message?: {
    id?: number
    text?: string
    author_id?: number
    date?: string
  }
  unread?: boolean
  counter?: number
  date_update?: string
}

/** A Bitrix24 user summary embedded in `im.dialog.messages.get`'s `users` array. */
export interface BitrixImUserRaw {
  id?: number | string
  name?: string
  first_name?: string
  last_name?: string
}

/** One message row from `im.dialog.messages.get`'s `messages` array. */
export interface BitrixImMessageRaw {
  id?: number
  chat_id?: number
  author_id?: number
  date?: string
  text?: string
}

/** Envelope for `im.dialog.messages.get`. */
export interface ImDialogMessagesEnvelope {
  chat_id?: number
  messages?: BitrixImMessageRaw[]
  users?: BitrixImUserRaw[]
}

/**
 * Envelope for `im.recent.list`. Unlike the older `im.recent.get` (bare
 * array, `LIMIT` silently ignored on a live-portal check), this one
 * genuinely paginates — `items` + `hasMore` confirmed against a live portal.
 */
export interface ImRecentListEnvelope {
  items?: BitrixImRecentRaw[]
  hasMore?: boolean
}
