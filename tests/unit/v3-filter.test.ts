import { afterEach, describe, expect, it } from 'vitest'
import { toV3Filter } from '../../server/utils/v3-filter'

describe('toV3Filter', () => {
  it('maps a plain equality to a 2-tuple [field, value]', () => {
    expect(toV3Filter({ taskId: 7 })).toEqual([['taskId', 7]])
  })

  it('maps multiple equalities preserving insertion order', () => {
    expect(toV3Filter({ taskId: 7, status: 'open' })).toEqual([
      ['taskId', 7],
      ['status', 'open'],
    ])
  })

  it('translates v2 prefix `!` to v3 operator `<>` (not equal)', () => {
    // Bitrix24 v3 spells not-equal as `<>`, not `!=`. The helper accepts
    // the v2-style `!` prefix and emits the v3 operator name.
    expect(toV3Filter({ '!status': 'closed' })).toEqual([['<>', 'status', 'closed']])
  })

  it('translates v2 prefix `!=` to v3 operator `<>` (same as `!`)', () => {
    expect(toV3Filter({ '!=status': 'closed' })).toEqual([['<>', 'status', 'closed']])
  })

  it('translates v2 prefix `%` to v3 operator `contains`', () => {
    // v3 uses `contains` instead of `%` for LIKE-style substring matches.
    expect(toV3Filter({ '%title': 'договор' })).toEqual([['contains', 'title', 'договор']])
  })

  it('passes `>=` / `<=` / `>` / `<` through unchanged (same in v2 and v3)', () => {
    expect(
      toV3Filter({
        '>=createdAt': '2025-01-01',
        '<=createdAt': '2025-12-31',
        '>id': 100,
        '<id': 200,
      }),
    ).toEqual([
      ['>=', 'createdAt', '2025-01-01'],
      ['<=', 'createdAt', '2025-12-31'],
      ['>', 'id', 100],
      ['<', 'id', 200],
    ])
  })

  it('matches longer prefixes first via sorted prefix list (`>=` does not truncate to `>`)', () => {
    // `!=` vs `!` is also covered by the dedicated translation tests
    // above (lines 19-22). This test pins the regex's longest-first
    // ordering on a different operator family to make the invariant
    // explicit regardless of the operator under test.
    expect(toV3Filter({ '>=created': 1 })).toEqual([['>=', 'created', 1]])
    expect(toV3Filter({ '<=created': 2 })).toEqual([['<=', 'created', 2]])
  })

  it('returns an empty array for an empty filter', () => {
    expect(toV3Filter({})).toEqual([])
  })

  it('passes through unrecognised prefix-looking keys unchanged', () => {
    // A leading character that isn't a known operator (e.g. `~`) is left as
    // part of the field name — the helper does not invent operators.
    // NB: if `~` is later added to V2_PREFIX_TO_V3_OPERATOR, this test
    // will start failing — that's intentional, the test pins the
    // closed-vocabulary contract.
    expect(toV3Filter({ '~weird': 1 })).toEqual([['~weird', 1]])
  })

  it('handles null and array values without coercing them', () => {
    expect(toV3Filter({ taskId: null, tags: [1, 2] })).toEqual([
      ['taskId', null],
      ['tags', [1, 2]],
    ])
  })

  it('combines operator prefix with null value (`!=fieldName: null` → `[<>, fieldName, null]`)', () => {
    // Operator translation and value type are orthogonal — a null value
    // must still flow through the operator path without coercion.
    expect(toV3Filter({ '!taskId': null })).toEqual([['<>', 'taskId', null]])
  })

  describe('LLM-controlled key hardening (issue #22)', () => {
    // Note on test construction: object literal `{ __proto__: 'evil' }` does
    // NOT create an own `__proto__` property — it sets the object's prototype
    // via the literal-form setter, and `Object.entries` returns []. The real
    // attack vector is `JSON.parse('{"__proto__":...}')`, which DOES create
    // an own enumerable `__proto__` property in modern V8. Tests that need
    // to exercise the key-strip guard for `__proto__` therefore go through
    // JSON.parse. Object literals work fine for `constructor` / `prototype`
    // — those names are not special in the literal-form setter.

    it('drops a raw `__proto__` key (JSON.parse vector) without leaking it to the wire', () => {
      const tainted = JSON.parse('{"__proto__":"evil"}') as Record<string, unknown>
      // Sanity-check the test fixture before asserting the guard's effect —
      // if V8 ever stops making `__proto__` an own property via JSON.parse,
      // this guard rail flags it loudly instead of letting the test
      // silently bypass the guard.
      expect(Object.entries(tainted)).toHaveLength(1)
      expect(toV3Filter(tainted)).toEqual([])
    })

    it('drops a raw `constructor` key', () => {
      expect(toV3Filter({ constructor: 'evil' })).toEqual([])
    })

    it('drops a raw `prototype` key', () => {
      expect(toV3Filter({ prototype: 'evil' })).toEqual([])
    })

    it('drops a forbidden key hidden behind an operator prefix (`!__proto__`)', () => {
      // The regex strips the operator and exposes `__proto__` as the field
      // name. Without the post-strip check, the helper would emit
      // `['<>', '__proto__', 'evil']`. The prefixed form goes through
      // literal syntax because `!__proto__` is not the literal-form setter
      // — only the bare `__proto__` key has that quirk.
      expect(toV3Filter({ '!__proto__': 'evil' })).toEqual([])
    })

    it('drops a forbidden key hidden behind a `%constructor` substring prefix', () => {
      expect(toV3Filter({ '%constructor': 'evil' })).toEqual([])
    })

    it('keeps the rest of the filter when one entry is forbidden (`__proto__` via JSON.parse)', () => {
      // The drop is per-key, not all-or-nothing — a legitimate filter that
      // accidentally includes a forbidden key (e.g. from a partial JSON
      // copy-paste) still works for the safe fields.
      const tainted = JSON.parse('{"taskId":7,"__proto__":"evil","status":"open"}') as Record<string, unknown>
      expect(toV3Filter(tainted)).toEqual([
        ['taskId', 7],
        ['status', 'open'],
      ])
    })

    it('does not pollute Object.prototype when a JSON.parse-derived `__proto__` is processed', () => {
      // End-to-end check against the actual attack vector: a real JSON.parse
      // of attacker-shaped JSON, where the value at `__proto__` is itself an
      // object (the classic prototype-pollution payload shape). The helper
      // must drop the key without ever assigning into `Object.prototype`.
      // afterEach below scrubs any leakage so neighbouring tests stay clean.
      const payload = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
      expect(Object.entries(payload)).toHaveLength(1) // fixture sanity
      toV3Filter(payload)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((Object.prototype as any).polluted).toBeUndefined()
    })

    afterEach(() => {
      // Vitest workers share globals — if a regression ever pollutes
      // `Object.prototype`, scrub it so the next test does not see a
      // ghost field.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (Object.prototype as any).polluted
    })
  })

  it('handles a mixed filter end-to-end with all translations applied', () => {
    expect(
      toV3Filter({
        taskId: 7,
        '!status': 'closed',
        '>=createdAt': '2025-01-01',
        '%title': 'q',
      }),
    ).toEqual([
      ['taskId', 7],
      ['<>', 'status', 'closed'],
      ['>=', 'createdAt', '2025-01-01'],
      ['contains', 'title', 'q'],
    ])
  })
})
