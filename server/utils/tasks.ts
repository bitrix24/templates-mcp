/**
 * Shared types and helpers for the Bitrix24 task tools.
 *
 * Bitrix24 REST returns task fields in mixed casing (UPPERCASE for legacy
 * v2-style endpoints, camelCase for v3 responses). The four task tools
 * (`bitrix24_create_task` / `_list_tasks` / `_update_task` /
 * `_add_task_comment`) accept inputs in camelCase (more LLM-friendly) and
 * map them to the UPPERCASE keys that the REST methods actually require.
 */

/** Subset of task fields we surface back to the agent. The full Bitrix24
 *  response carries 50+ fields; trimming to the agent-useful ones keeps the
 *  context window cheap. Agents that need more should use list-tasks with an
 *  explicit `select`. */
export interface TaskShort {
  id: number | string
  title: string
  status?: string
  deadline?: string | null
  responsibleId?: string
  createdDate?: string
  priority?: string
}

/**
 * Picks a field that may be in either camelCase or UPPERCASE in the Bitrix24
 * response. Returns `null` if neither is present, so the caller decides
 * whether to fall back or omit.
 */
function pick<T>(obj: Record<string, unknown>, lower: string, upper: string): T | null {
  const v = obj[lower] ?? obj[upper]
  return v === undefined ? null : (v as T)
}

export function toTaskShort(raw: unknown): TaskShort | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = pick<number | string>(r, 'id', 'ID')
  const title = pick<string>(r, 'title', 'TITLE')
  if (id === null || title === null) return null
  return {
    id,
    title,
    status: pick<string>(r, 'status', 'STATUS') ?? undefined,
    deadline: pick<string>(r, 'deadline', 'DEADLINE') ?? undefined,
    responsibleId: pick<string>(r, 'responsibleId', 'RESPONSIBLE_ID') ?? undefined,
    createdDate: pick<string>(r, 'createdDate', 'CREATED_DATE') ?? undefined,
    priority: pick<string>(r, 'priority', 'PRIORITY') ?? undefined,
  }
}

/**
 * Bitrix24's `tasks.task.list` returns `{result: {tasks: [...], total: N}}`.
 * Some other endpoints (e.g. `tasks.task.add`) wrap in `{result: {task: {...}}}`.
 * This function tolerates both shapes and a few null variants.
 */
export function extractTasks(rawResult: unknown): TaskShort[] {
  if (!rawResult || typeof rawResult !== 'object') return []
  const r = rawResult as Record<string, unknown>
  const tasks = r.tasks ?? r.task
  if (Array.isArray(tasks)) {
    return tasks.map(toTaskShort).filter((t): t is TaskShort => t !== null)
  }
  if (tasks && typeof tasks === 'object') {
    const single = toTaskShort(tasks)
    return single ? [single] : []
  }
  return []
}

/**
 * Bitrix24's task statuses are integers stringified in the REST layer.
 * Documented values (subset relevant for filtering / display):
 *   1 — new (исп. редко в прод-портал, обычно сразу 2)
 *   2 — pending / in queue
 *   3 — in progress
 *   4 — supposedly completed
 *   5 — completed
 *   6 — deferred
 *   7 — declined
 */
export const TASK_STATUS = {
  PENDING: 2,
  IN_PROGRESS: 3,
  COMPLETED_PROVISIONAL: 4,
  COMPLETED: 5,
  DEFERRED: 6,
  DECLINED: 7,
} as const
