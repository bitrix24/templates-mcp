/**
 * `toV3Filter` — convert an LLM-friendly filter object into the Bitrix24 v3
 * REST list-filter contract.
 *
 * v3 list endpoints (`tasks.task.result.list`, … — the genuinely v3-only
 * `/rest/api/` methods; NOT classic v2 lists like `tasks.task.list` or
 * `task.checklistitem.getlist`, which stay on v2 and keep the object-shaped
 * filter) reject the v2 object-shaped `{ key: value }` form and require an
 * array of conditions instead:
 *
 *   - Equality: `[field, value]`
 *   - With operator: `[operator, field, value]`
 *
 * Direction of conversion: **input is v2-key notation** (the prefix
 * convention the rest of this codebase uses for `tasks.task.list`), **output
 * is v3-array notation** with operator names from the v3 vocabulary. The
 * helper translates each v2 prefix to its v3 equivalent so callers keep one
 * mental model across both eras.
 *
 * Operator translation table (input prefix → v3 operator) per
 * https://apidocs.bitrix24.com/api-reference/rest-v3/tasks/result/tasks-task-result-list.html
 * "Available filter operators":
 *
 *   - `!`  / `!=`  → `<>`         (not equal — v3's spelling)
 *   - `%`          → `contains`   (LIKE-style substring match)
 *   - `>=`         → `>=`
 *   - `<=`         → `<=`
 *   - `>`          → `>`
 *   - `<`          → `<`
 *   - no prefix    → equality (2-tuple, no operator slot)
 *
 * v3 also documents `in`, `not in`, `not contains`, `starts with`,
 * `ends with` — these have no v2-prefix equivalent and aren't surfaced via
 * this helper today. Callers that need them should construct the tuple
 * literal directly (operator-first per the 3-tuple shape:
 * `['in', 'fieldName', [1, 2, 3]]`) — a future overload may accept
 * pre-built {@link V3FilterCondition}[] alongside the object form.
 *
 * Why centralise: `tasks.task.result.list` already uses this contract
 * (see `list-task-results.ts`) and more v3 endpoints land in Phase 2. One
 * helper means one place to audit when Bitrix24 documents a new operator.
 *
 * Example:
 *   toV3Filter({ taskId: 7, '!status': 'closed', '>=createdAt': '2025-01-01', '%title': 'q' })
 *     → [
 *         ['taskId', 7],
 *         ['<>', 'status', 'closed'],
 *         ['>=', 'createdAt', '2025-01-01'],
 *         ['contains', 'title', 'q'],
 *       ]
 *
 * Order in the output is the insertion order of the input object (per ES
 * spec for string keys), which keeps test fixtures stable.
 *
 * **Safe against LLM-controlled keys.** Keys named `__proto__`, `constructor`,
 * or `prototype` are silently dropped (both as raw keys and as stripped field
 * names after operator-prefix removal). These are JavaScript-special
 * identifiers that should never reach Bitrix24's REST wire as field names;
 * blocking them at this seam prevents an LLM-routed JSON.parse'd filter from
 * smuggling them into the request payload. Issue #22.
 */

/**
 * Single condition in a v3 filter. Equality is a 2-tuple `[field, value]`;
 * a comparison uses a 3-tuple `[operator, field, value]`. Bitrix24 accepts
 * the operator in the leading position only — putting it inside the field
 * string is the v2 contract and is rejected by v3 endpoints.
 */
export type V3FilterCondition = [field: string, value: unknown] | [op: string, field: string, value: unknown]

/** v2-prefix → v3-operator translation table. Drives both the regex and
 *  the per-key conversion. Keep operator names exactly as Bitrix24's v3
 *  docs spell them — `<>` not `!=`, `contains` not `%`. */
const V2_PREFIX_TO_V3_OPERATOR: Record<string, string> = {
  '!=': '<>',
  '!': '<>',
  '%': 'contains',
  '>=': '>=',
  '<=': '<=',
  '>': '>',
  '<': '<',
}

/** Order matters: longer prefixes must match first so `>=` doesn't get
 *  truncated to `>`, and `!=` doesn't get truncated to `!`. Built from the
 *  translation table keys, sorted longest-first, then RegExp-escaped. */
const OPERATOR_PREFIX_RE = (() => {
  const prefixes = Object.keys(V2_PREFIX_TO_V3_OPERATOR)
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^(${prefixes.join('|')})?(.+)$`)
})()

/** Reserved JS identifiers that must never appear as field names on the v3
 *  wire — see file-level JSDoc and issue #22. The check applies to both the
 *  raw key and the stripped field name after operator-prefix removal. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export function toV3Filter(filter: Record<string, unknown>): V3FilterCondition[] {
  const out: V3FilterCondition[] = []
  for (const [key, value] of Object.entries(filter)) {
    // `Object.entries` only walks own enumerable properties, but JSON.parse
    // makes `__proto__` an own property in modern V8 — so an LLM-routed
    // `{"__proto__": ...}` reaches us as a normal key, not a prototype hop.
    // Block it explicitly here so it never makes it to the wire payload.
    if (FORBIDDEN_KEYS.has(key)) continue
    const match = OPERATOR_PREFIX_RE.exec(key)
    // Regex matches every non-empty key (the `.+` requires ≥1 char after
    // the optional prefix). The `!match` branch handles the only failure
    // mode — an empty-string key — by passing it through verbatim; Bitrix24
    // will reject it server-side, which is the correct failure surface.
    if (!match) {
      out.push([key, value])
      continue
    }
    const prefix = match[1] ?? ''
    const field = match[2] ?? key
    // The stripped field name is also a wire identifier; block forbidden
    // keys that hide behind an operator prefix, e.g. `!__proto__`.
    if (FORBIDDEN_KEYS.has(field)) continue
    if (!prefix) {
      out.push([field, value])
      continue
    }
    // Defensive `?? prefix` covers a future entry in the regex that lacks
    // a translation table row; the v3 server would reject it loudly with
    // BITRIX_REST_V3_EXCEPTION_UNKNOWNFILTEROPERATOREXCEPTION.
    const v3Operator = V2_PREFIX_TO_V3_OPERATOR[prefix] ?? prefix
    out.push([v3Operator, field, value])
  }
  return out
}
