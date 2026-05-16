import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { toToolError } from '~/server/utils/errors'

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
export default defineMcpTool({
  name: 'bitrix24_find_user',
  description:
    'Find Bitrix24 users by name / surname / position / department, or a free-text query across all of them. Use this BEFORE any tool that needs a userId — operators speak in names, not numeric ids. If the response has duplicates, narrow down with `lastName` or `position` and ask the operator to confirm. Returns id, name, last name, position, and department membership for each match.',
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe(
        'Free-text query — matched across first name, last name, position, and department name. Use this when the operator gives a single name like "Igor" or "Igor Shevchenko". Mutually exclusive with the structured filters below — supply either `query` OR a combination of `firstName`/`lastName`/`position`.',
      ),
    firstName: z
      .string()
      .optional()
      .describe('Exact-or-prefix match on first name. Use together with `lastName` when the operator gives "Имя Фамилия".'),
    lastName: z
      .string()
      .optional()
      .describe('Exact-or-prefix match on last name. The disambiguator when `firstName` alone has duplicates.'),
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
  handler: async ({ query, firstName, lastName, position, limit }) => {
    const filter: Record<string, unknown> = {}
    if (query) {
      filter.FIND = query
    } else {
      if (firstName) filter.NAME = firstName
      if (lastName) filter.LAST_NAME = lastName
      if (position) filter.WORK_POSITION = position
    }

    if (Object.keys(filter).length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Provide at least one of: query, firstName, lastName, position. Without a filter the API returns all users on the portal — not useful for resolving a name.',
          },
        ],
      }
    }

    try {
      const b24 = useBitrix24()
      const response = await b24.callMethod('user.search', { FILTER: filter, sort: 'ID', order: 'ASC' })
      const data = response.getData()?.result as
        | Array<{
            ID?: string | number
            NAME?: string
            LAST_NAME?: string
            SECOND_NAME?: string
            EMAIL?: string
            WORK_POSITION?: string
            UF_DEPARTMENT?: number[]
            ACTIVE?: boolean
            IS_ONLINE?: string
          }>
        | undefined

      const cap = limit ?? 10
      const users = (data ?? []).slice(0, cap).map((u) => ({
        id: typeof u.ID === 'string' ? Number.parseInt(u.ID, 10) : (u.ID ?? null),
        firstName: u.NAME ?? null,
        lastName: u.LAST_NAME ?? null,
        secondName: u.SECOND_NAME || null,
        email: u.EMAIL ?? null,
        position: u.WORK_POSITION || null,
        departmentIds: u.UF_DEPARTMENT ?? [],
        active: u.ACTIVE !== false,
        isOnline: u.IS_ONLINE === 'Y',
      }))

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                matches: users.length,
                truncatedAt: cap,
                totalReturned: (data ?? []).length,
                users,
              },
              null,
              2,
            ),
          },
        ],
      }
    } catch (err) {
      throw toToolError(err, 'Failed to search Bitrix24 users')
    }
  },
})
