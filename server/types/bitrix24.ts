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
