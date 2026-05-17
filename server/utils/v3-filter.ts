/**
 * `toV3Filter` — convert an LLM-friendly filter object into the Bitrix24 v3
 * REST list-filter contract.
 *
 * v3 list endpoints (`tasks.task.result.list`, `crm.deal.list`,
 * `crm.contact.list`, …) reject the v2 object-shaped `{ key: value }` form
 * and require an array of conditions instead:
 *
 *   - Equality: `[field, value]`
 *   - With operator: `[operator, field, value]`
 *
 * Operators recognised: `!` (not equal), `>=` / `<=` (range), `>` / `<`
 * (strict range), `%` (LIKE). These match the prefix convention used by the
 * legacy v2 contract (`tasks.task.list`) so callers can keep one mental
 * model across both eras.
 *
 * Why centralise: `tasks.task.result.list` already needs this contract today
 * (the only consumer for now writes the array literal by hand) and CRM
 * list endpoints land on the same shape. One helper means one place to
 * audit when Bitrix24 documents a new operator or quirk.
 *
 * Example:
 *   toV3Filter({ taskId: 7, '!status': 'closed', '>=createdAt': '2025-01-01' })
 *     → [
 *         ['taskId', 7],
 *         ['!', 'status', 'closed'],
 *         ['>=', 'createdAt', '2025-01-01'],
 *       ]
 *
 * Order in the output is the insertion order of the input object (per ES
 * spec for string keys), which keeps test fixtures stable.
 */

/**
 * Single condition in a v3 filter. Equality is a 2-tuple `[field, value]`;
 * a comparison uses a 3-tuple `[operator, field, value]`. Bitrix24 accepts
 * the operator in the leading position only — putting it inside the field
 * string is the v2 contract and is rejected by v3 endpoints.
 */
export type V3FilterCondition = [field: string, value: unknown] | [op: string, field: string, value: unknown]

/** Operator prefixes recognised by the v2 list contract. Order matters in
 *  the regex — longer prefixes must match first so `>=` doesn't get truncated
 *  to `>`. */
const OPERATOR_PREFIX_RE = /^(>=|<=|!=|!|%|>|<)?(.+)$/

export function toV3Filter(filter: Record<string, unknown>): V3FilterCondition[] {
  const out: V3FilterCondition[] = []
  for (const [key, value] of Object.entries(filter)) {
    const match = OPERATOR_PREFIX_RE.exec(key)
    // The regex always matches (`.+` is non-empty per Object.entries spec);
    // the conditional is a defensive cast for TS.
    if (!match) {
      out.push([key, value])
      continue
    }
    const operator = match[1] ?? ''
    const field = match[2] ?? key
    if (operator) {
      out.push([operator, field, value])
    } else {
      out.push([field, value])
    }
  }
  return out
}
