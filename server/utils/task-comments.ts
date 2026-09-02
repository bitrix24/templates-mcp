import { pick, toNumber } from '~/server/utils/wire-coerce'

/**
 * Pure parser for `task.commentitem.getlist` response items. Mirrors what
 * `toTaskShort` / `toChecklistItemShort` do for their respective domains:
 * narrow the agent-facing shape, coerce stringified numeric ids, leave the
 * tool body free of wire-format quirks.
 */

export interface TaskCommentShort {
  id: number
  taskId: number
  authorId: number | null
  authorName: string | null
  text: string
  postDate: string | null
}

export function toTaskCommentShort(raw: unknown): TaskCommentShort | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = toNumber(pick(r, 'id', 'ID'))
  const taskId = toNumber(pick(r, 'taskId', 'TASK_ID'))
  if (id === null || taskId === null) return null
  return {
    id,
    taskId,
    authorId: toNumber(pick(r, 'authorId', 'AUTHOR_ID')),
    authorName: pick<string>(r, 'authorName', 'AUTHOR_NAME'),
    text: pick<string>(r, 'postMessage', 'POST_MESSAGE') ?? '',
    postDate: pick<string>(r, 'postDate', 'POST_DATE'),
  }
}
