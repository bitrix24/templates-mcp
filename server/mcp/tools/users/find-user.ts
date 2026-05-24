import type { TypeCallParams } from '@bitrix24/b24jssdk'
import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV2 } from '~/server/utils/sdk-helpers'

/** Subset of the `user.search` row shape we surface back to the agent. */
interface UserSearchRow {
  ID?: string | number
  NAME?: string
  LAST_NAME?: string
  SECOND_NAME?: string
  EMAIL?: string
  WORK_POSITION?: string
  UF_DEPARTMENT?: number[]
  ACTIVE?: boolean
  IS_ONLINE?: string
}

/**
 * Find Bitrix24 users by name, surname, position, or free-text query.
 *
 * Bitrix24 REST: user.search
 *   https://apidocs.bitrix24.com/api-reference/user/user-search.html
 *
 * This tool is what lets the agent take "create a task for Игорь" and
 * resolve it to a user id without making the operator type numeric ids.
 * It is intentionally read-only and broad — the agent narrows down by
 * surname or position when the first response has duplicates.
 */

/**
 * Bitrix24 returns user IDs as numeric strings. Coerce to a real number;
 * return null for absent or non-numeric values rather than emitting NaN
 * (which JSON.stringify silently turns into `null` and confuses the agent
 * about whether the field was missing or malformed).
 */
function parseUserId(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw
  return Number.isFinite(n) ? n : null
}
export default defineMcpTool({
  name: 'b24_user_find',
  description:
    'Find Bitrix24 users by name / patronymic / surname / position / department, or a free-text query across all of them. Use this BEFORE any tool that needs a userId — operators speak in names, not numeric ids. The response includes `secondName` (Bitrix24 SECOND_NAME field) — used as a disambiguator especially for Russian-style "Имя Отчество Фамилия"; most non-Russian portals leave this empty. If the response has duplicates, narrow down in this order: `secondName` (patronymic) → `lastName` → `position`, and ask the operator to confirm. Returns id, name, patronymic, last name, position, and department membership for each match.',
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe(
        'Free-text query — matched across first name, last name, position, and department name. Bitrix24 full-text typically also covers patronymic (otchestvo). Use this when the operator gives a full or partial name string like "Igor", "Игорь Сергеевич", or "Шевченко Игорь". Mutually exclusive with the structured filters below — supply either `query` OR a combination of `firstName`/`lastName`/`secondName`/`position`.',
      ),
    firstName: z
      .string()
      .optional()
      .describe('Exact-or-prefix match on first name. Use together with `lastName` when the operator gives "Имя Фамилия".'),
    secondName: z
      .string()
      .optional()
      .describe('Patronymic (отчество) — exact-or-prefix match. The natural disambiguator in Russian usage when first names collide ("Игорь Сергеевич" vs "Игорь Алексеевич"). Bitrix24 SECOND_NAME field.'),
    lastName: z
      .string()
      .optional()
      .describe('Exact-or-prefix match on last name. The disambiguator when `firstName` alone has duplicates and no patronymic was supplied.'),
    position: z
      .string()
      .optional()
      .describe('Job title fragment ("backend", "manager"). Useful when names collide and the operator mentions the role.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Cap on the returned matches. Default 10. Bitrix24 paginates at 50; if you need more, run the search again with a tighter filter.'),
  },
  handler: async ({ query, firstName, secondName, lastName, position, limit }) => {
    const hasStructured = Boolean(firstName || secondName || lastName || position)
    if (query && hasStructured) {
      // Bitrix24's user.search rejects FIND combined with named-field filters,
      // and silently picking one over the other would surprise the caller.
      // Surface this as an inline error so the agent can retry cleanly.
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Use either `query` (free-text FIND) OR the structured filters (firstName / secondName / lastName / position), not both.',
          },
        ],
      }
    }

    const filter: Record<string, unknown> = {}
    if (query) {
      filter.FIND = query
    } else {
      if (firstName) filter.NAME = firstName
      if (secondName) filter.SECOND_NAME = secondName
      if (lastName) filter.LAST_NAME = lastName
      if (position) filter.WORK_POSITION = position
    }

    if (Object.keys(filter).length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Provide at least one of: query, firstName, secondName, lastName, position. Without a filter the API returns all users on the portal — not useful for resolving a name.',
          },
        ],
      }
    }

    const b24 = useBitrix24()
    // user.search is v2 and uses a non-standard params shape: `order` is a
    // scalar 'ASC' / 'DESC' (not the `Record<string, 'ASC' | 'DESC'>`
    // documented by `TypeCallParams.order`). The SDK type is wrong for this
    // one endpoint; this single cast bridges the type-system gap without
    // forcing every other callsite to widen.
    const all
      = (await callV2<UserSearchRow[]>(
          b24,
          'user.search',
          { FILTER: filter, sort: 'ID', order: 'ASC' } as unknown as TypeCallParams,
          'Failed to search Bitrix24 users',
        ))
      ?? []

    const cap = limit ?? 10
    const users = all.slice(0, cap).map((u) => ({
      id: parseUserId(u.ID),
      // `||` (not `??`) on all string fields: Bitrix24 sometimes returns an
      // empty string for an unset name part / position / email; an empty
      // string is semantically "absent", so we map it to null uniformly.
      firstName: u.NAME || null,
      lastName: u.LAST_NAME || null,
      secondName: u.SECOND_NAME || null,
      email: u.EMAIL || null,
      position: u.WORK_POSITION || null,
      departmentIds: u.UF_DEPARTMENT ?? [],
      active: u.ACTIVE !== false,
      isOnline: u.IS_ONLINE === 'Y',
    }))

    const truncated = all.length > users.length

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            matches: users.length,
            returnedByApi: all.length,
            ...(truncated ? { truncatedAt: cap } : {}),
            users,
          }),
        },
      ],
    }
  },
})
