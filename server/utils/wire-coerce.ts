/**
 * Wire-format coercions for Bitrix24 REST responses.
 *
 * Bitrix24 ships fields in mixed casing (UPPERCASE for legacy v2-style
 * endpoints, camelCase for v3 responses) and stringifies numeric ids in
 * both. These helpers — previously copy-pasted across `tasks.ts`,
 * `checklist.ts`, and `task-results.ts` — live here as the single source of
 * truth so that drift between domains stays impossible.
 */

/**
 * Picks a field that may be in either camelCase or UPPERCASE on the wire.
 * Returns `null` when:
 *   - neither key is present
 *   - the camelCase value is explicitly `null` or `undefined` AND the
 *     UPPERCASE value is absent (the `??` falls through, then the final
 *     `v === undefined` check normalises absent to `null`)
 *
 * Note the asymmetry from `??` semantics: `pick({id: null, ID: 5}, 'id', 'ID')`
 * returns `5`, not `null` — an explicit nullish camelCase value falls
 * through to UPPERCASE. This matches the intent (Bitrix24 sometimes ships
 * `null` for fields it has no data for, and the legacy UPPERCASE value
 * is the meaningful payload). The `Object.hasOwn` guard below does not
 * change this — an own `null` at `lower` is still own, still becomes
 * `null` in `lowerVal`, and still falls through `null ?? upperVal`.
 *
 * Order is `lower` (camelCase) first, then `upper` (UPPER_SNAKE) — v3
 * responses are camelCase and we prefer them.
 *
 * **Own-property only.** `hasOwn` guards both lookups so inherited prototype
 * properties never surface as wire values. Every current callsite passes
 * string literals for `lower` / `upper`, but the guard is cheap and removes
 * an entire class of future bug where an attacker-controlled key reaches
 * this helper through a Zod-validated `Record<string, unknown>`. Issue #22.
 */
export function pick<T>(obj: Record<string, unknown>, lower: string, upper: string): T | null {
  // Lookup-then-coalesce, but each branch goes through `hasOwn` so a
  // prototype-resident value never enters `v`. Preserves the `??` asymmetry
  // documented above: an own `null` at `lower` still falls through to `upper`.
  const lowerVal = Object.hasOwn(obj, lower) ? obj[lower] : undefined
  const upperVal = Object.hasOwn(obj, upper) ? obj[upper] : undefined
  const v = lowerVal ?? upperVal
  return v === undefined ? null : (v as T)
}

/**
 * Coerce a wire-side value (stringified int, number, null, '') to a real
 * number, returning `null` for absent / malformed inputs rather than NaN.
 * `JSON.stringify` quietly turns NaN into `null`, which would conflate
 * "missing" with "malformed" downstream.
 *
 * Designed for integer wire fields (Bitrix24 ids are always integers in the
 * REST contract). Float strings like `"3.7"` are silently truncated to `3`
 * via `parseInt`; numeric inputs pass through unchanged (so `toNumber(3.7)`
 * returns `3.7`). This is intentional — every documented use of this
 * helper is for an id field, and surfacing a partial parse as `null` would
 * lose data when Bitrix24 ships an unexpected decimal.
 */
export function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : (raw as number)
  return Number.isFinite(n) ? n : null
}

/**
 * Bitrix24 v2 ships boolean fields as the literal strings `"Y"` / `"N"`.
 * Anything else is treated as `false` rather than silently accepted — drift
 * surfaces loud instead of producing wrong-but-truthy data.
 */
export function toBool(raw: unknown): boolean {
  return raw === 'Y'
}
