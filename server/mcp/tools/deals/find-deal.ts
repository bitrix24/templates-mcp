import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { callV3 } from '~/server/utils/sdk-helpers'

/**
 * Whitelist of deal fields the agent may sort by. Kept to a fixed enum rather
 * than an open `z.string()` key so an LLM can't probe the portal's custom-field
 * schema (`UF_CRM_*`) through which-field-errors / which-field-sorts behaviour.
 */
const SORTABLE_FIELD = z.enum([
  'ID',
  'TITLE',
  'DATE_CREATE',
  'DATE_MODIFY',
  'OPPORTUNITY',
  'STAGE_ID',
  'CATEGORY_ID',
  'ASSIGNED_BY_ID',
  'CLOSED',
])

/**
 * Subset of the `crm.deal.list` row shape we surface back to the agent. The
 * Bitrix24 API returns scalar fields as strings (numeric ids, money amounts,
 * Y/N flags) — we coerce to native JS types at the boundary so the LLM
 * doesn't have to reason about quoted numbers.
 */
interface DealListRow {
  ID?: string | number
  TITLE?: string
  STAGE_ID?: string
  CATEGORY_ID?: string | number
  TYPE_ID?: string | null
  OPPORTUNITY?: string | number | null
  CURRENCY_ID?: string | null
  CONTACT_ID?: string | number | null
  COMPANY_ID?: string | number | null
  ASSIGNED_BY_ID?: string | number | null
  CLOSED?: 'Y' | 'N'
  DATE_CREATE?: string | null
  DATE_MODIFY?: string | null
}

/**
 * Find Bitrix24 CRM deals (sales opportunities) by title fragment or by
 * structured filters (stage, category, assigned user, contact, company).
 *
 * Bitrix24 REST: crm.deal.list
 *   https://apidocs.bitrix24.com/api-reference/crm/deals/crm-deal-list.html
 *
 * Reference implementation for the "fork and extend" path the landing
 * advertises. The tool is intentionally small — single REST call, no batch,
 * no mutation — so a contributor can read it end-to-end as a starting point
 * for their own CRM tools.
 *
 * "Find by associated contact name" is documented in the landing prompt but
 * needs a two-step workflow: resolve the contact's id via a yet-to-be-shipped
 * `bitrix24_find_contact` tool, then pass that id as `contactId` here. This
 * tool accepts `contactId` directly; the contact-name resolution is left as
 * the next thing a forker would build.
 */

/**
 * Bitrix24 returns deal ids and amounts as numeric strings. Coerce to a real
 * number; return null for absent or non-numeric values rather than emitting
 * NaN (which JSON.stringify silently turns into `null` and confuses the agent
 * about whether the field was missing or malformed).
 */
function parseId(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw
  return Number.isFinite(n) ? n : null
}

/**
 * Coerce a money amount to a number. Bitrix24 emits `OPPORTUNITY` as a numeric
 * string ("19999.99"), and an empty string ("") for a deal with no amount set.
 * Both the empty string and a non-numeric value map to null — same "absent vs
 * malformed is indistinguishable, so normalise to null" contract as parseId.
 */
function parseMoney(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'string' ? Number.parseFloat(raw) : raw
  return Number.isFinite(n) ? n : null
}

export default defineMcpTool({
  name: 'bitrix24_find_deal',
  description:
    'Find Bitrix24 CRM deals (sales opportunities — "Negociação" in the Brazilian Portuguese UI; equivalent to a Salesforce Opportunity). Filter by a free-text title fragment (LIKE match) and / or structured fields: contactId, companyId, stageId, categoryId, assignedById, closedOnly. At least one filter is required — without one the portal returns every deal, which is rarely what you want. Returns up to one page (max 50, capped further by `limit`) of: id / title / stageId / categoryId / typeId / opportunity / currencyId / contactId / companyId / assignedById / isClosed / dateCreate / dateModify. Use `order` to sort — e.g. `{ "DATE_MODIFY": "ASC" }` puts the most stale deals first, the right sort for a "deals idle for N days" report. To search by an associated contact, pass that contact\'s numeric id as `contactId`.',
  inputSchema: {
    query: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        'Free-text fragment matched against the deal title (LIKE; Bitrix24 `%TITLE` filter prefix). Use this when the operator gives a project / customer / contract name like "договор Сидорова" or "Acme renewal". Case-insensitive on most portal locales. Note: `%` and `_` are SQL LIKE wildcards on the Bitrix24 side — a query of just "%" matches every deal.',
      ),
    contactId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Primary CRM contact id attached to the deal. Resolve from a name via a separate find-contact tool before calling here — Bitrix24\'s deal filter does not search by contact name directly.',
      ),
    companyId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Primary CRM company id attached to the deal.'),
    stageId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Deal stage in the form `<categorySlug>:<stageCode>` — e.g. `C1:NEW`, `C1:WON`, `LOSE`. Categories beyond the default pipeline use the `C<n>` prefix. Use this to narrow to "open deals at the proposal stage" or "lost deals".',
      ),
    categoryId: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Pipeline / funnel id. 0 is the default pipeline; custom pipelines are 1, 2, … Combine with `stageId` to narrow within one pipeline.'),
    assignedById: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Bitrix24 user id of the deal owner. Use `bitrix24_find_user` first to resolve a name to an id.'),
    closedOnly: z
      .boolean()
      .optional()
      .describe('When true, return only closed (won or lost) deals. When false, return only open deals. Omit to include both.'),
    order: z
      .record(SORTABLE_FIELD, z.enum(['ASC', 'DESC']))
      .optional()
      .describe(
        'Sort order. Keys are a fixed set of UPPER_SNAKE deal fields (ID, TITLE, DATE_CREATE, DATE_MODIFY, OPPORTUNITY, STAGE_ID, CATEGORY_ID, ASSIGNED_BY_ID, CLOSED); values are `ASC` / `DESC`. Default `{ ID: "DESC" }` (newest first). For a "deals idle for N days" report set `{ "DATE_MODIFY": "ASC" }` so the most stale deals come first within the single page this tool returns.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Cap on the returned matches. Default 10. This tool returns a single Bitrix24 page (max 50) — there is no pagination cursor yet, so use `order` to put the rows you care about at the top rather than relying on paging through everything.'),
  },
  handler: async ({ query, contactId, companyId, stageId, categoryId, assignedById, closedOnly, order, limit }) => {
    const filter: Record<string, unknown> = {}
    // Bitrix24 v3 filter prefix `%FIELD` = LIKE-contains; the SDK passes the
    // key through verbatim, so the percent sign must live in the key, not the
    // value. Same convention as task list's title-search filter.
    if (query) filter['%TITLE'] = query
    if (contactId !== undefined) filter.CONTACT_ID = contactId
    if (companyId !== undefined) filter.COMPANY_ID = companyId
    if (stageId) filter.STAGE_ID = stageId
    if (categoryId !== undefined) filter.CATEGORY_ID = categoryId
    if (assignedById !== undefined) filter.ASSIGNED_BY_ID = assignedById
    if (closedOnly !== undefined) filter.CLOSED = closedOnly ? 'Y' : 'N'

    if (Object.keys(filter).length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Provide at least one filter (query, contactId, companyId, stageId, categoryId, assignedById, or closedOnly). Without one the API returns every deal on the portal — not useful for finding a specific one.',
          },
        ],
      }
    }

    const select = [
      'ID',
      'TITLE',
      'STAGE_ID',
      'CATEGORY_ID',
      'TYPE_ID',
      'OPPORTUNITY',
      'CURRENCY_ID',
      'CONTACT_ID',
      'COMPANY_ID',
      'ASSIGNED_BY_ID',
      'CLOSED',
      'DATE_CREATE',
      'DATE_MODIFY',
    ]

    // `order ?? { ID: 'DESC' }` is not enough: an empty object `{}` is truthy,
    // so it would slip past `??` and ask Bitrix24 to sort by nothing. Treat a
    // missing OR empty order as "use the default".
    const effectiveOrder = order && Object.keys(order).length > 0 ? order : { ID: 'DESC' }

    const b24 = useBitrix24()
    const all
      = (await callV3<DealListRow[]>(
          b24,
          'crm.deal.list',
          { filter, select, order: effectiveOrder },
          'Failed to search Bitrix24 deals',
        ))
      ?? []

    const cap = limit ?? 10
    const deals = all.slice(0, cap).map((d) => ({
      id: parseId(d.ID),
      title: d.TITLE || null,
      stageId: d.STAGE_ID || null,
      categoryId: parseId(d.CATEGORY_ID),
      typeId: d.TYPE_ID || null,
      opportunity: parseMoney(d.OPPORTUNITY),
      currencyId: d.CURRENCY_ID || null,
      contactId: parseId(d.CONTACT_ID),
      companyId: parseId(d.COMPANY_ID),
      assignedById: parseId(d.ASSIGNED_BY_ID),
      isClosed: d.CLOSED === 'Y',
      dateCreate: d.DATE_CREATE || null,
      dateModify: d.DATE_MODIFY || null,
    }))

    const truncated = all.length > deals.length

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            matches: deals.length,
            // `pageSize` is how many rows this single Bitrix24 page held (≤50),
            // NOT the total count on the portal — there is no pagination cursor
            // yet (see issue #70). `mayHaveMore` flags a full page so the agent
            // knows to narrow the filter rather than assume it has seen
            // everything.
            pageSize: all.length,
            mayHaveMore: all.length >= 50,
            ...(truncated ? { truncatedAt: cap } : {}),
            deals,
          }),
        },
      ],
    }
  },
})
