import type { BitrixTaskResultRaw } from '~/server/types/bitrix24'
import { toNumber } from '~/server/utils/wire-coerce'

/**
 * Pure parser for `tasks.task.result.*` response items. Mirrors what
 * `toTaskShort` / `toChecklistItemShort` do for their respective domains:
 * narrow the agent-facing shape, coerce stringified numeric ids, leave the
 * tool body free of wire-format quirks.
 */

export interface TaskResultShort {
  id: number
  taskId: number
  text: string
  authorId: number | null
  createdAt: string | null
  updatedAt: string | null
  status: string | null
  messageId: number | null
}

export function toTaskResultShort(raw: unknown): TaskResultShort | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as BitrixTaskResultRaw
  const id = toNumber(r.id)
  const taskId = toNumber(r.taskId)
  if (id === null || taskId === null) return null
  return {
    id,
    taskId,
    text: typeof r.text === 'string' ? r.text : '',
    authorId: toNumber(r.authorId),
    createdAt: r.createdAt ?? null,
    updatedAt: r.updatedAt ?? null,
    status: typeof r.status === 'string' ? r.status : null,
    messageId: toNumber(r.messageId),
  }
}
