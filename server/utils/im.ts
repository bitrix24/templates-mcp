import type { BitrixImMessageRaw, BitrixImRecentRaw, BitrixImUserRaw } from '~/server/types/bitrix24'

/**
 * Pure parsers for the `im.*` (messenger) REST responses. The `im` module
 * ships a single consistent `snake_case` wire casing — no dual UPPER_SNAKE /
 * camelCase handling needed here, unlike `tasks.ts` / `checklist.ts`.
 */

export interface ImDialogShort {
  /** Pass this straight to `b24_im_message_list`'s `dialogId`. */
  dialogId: string
  /** `"user"` = personal dialog (a direct message); `"chat"` = group / task chat. */
  type: string
  title: string | null
  unread: boolean
  unreadCount: number
  lastMessageText: string | null
  lastMessageAuthorId: number | null
  lastMessageDate: string | null
}

export function toImDialogShort(raw: unknown): ImDialogShort | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as BitrixImRecentRaw
  if (r.id === undefined || r.id === null) return null
  return {
    dialogId: String(r.id),
    type: r.type ?? 'unknown',
    title: r.title ?? null,
    unread: r.unread ?? false,
    unreadCount: r.counter ?? 0,
    lastMessageText: r.message?.text ?? null,
    lastMessageAuthorId: r.message?.author_id ?? null,
    lastMessageDate: r.message?.date ?? null,
  }
}

export interface ImMessageShort {
  id: number
  authorId: number | null
  authorName: string | null
  text: string
  date: string | null
}

/** Builds an `authorId -> display name` lookup from `im.dialog.messages.get`'s `users` array. */
export function buildImUserNameMap(users: BitrixImUserRaw[] | undefined): Map<number, string> {
  const map = new Map<number, string>()
  for (const u of users ?? []) {
    const id = typeof u.id === 'string' ? Number.parseInt(u.id, 10) : u.id
    if (id === undefined || !Number.isFinite(id)) continue
    const name = u.name ?? [u.first_name, u.last_name].filter(Boolean).join(' ')
    if (name) map.set(id, name)
  }
  return map
}

export function toImMessageShort(raw: unknown, userNames: Map<number, string>): ImMessageShort | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as BitrixImMessageRaw
  if (r.id === undefined) return null
  return {
    id: r.id,
    authorId: r.author_id ?? null,
    authorName: r.author_id !== undefined ? (userNames.get(r.author_id) ?? null) : null,
    text: r.text ?? '',
    date: r.date ?? null,
  }
}
