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
