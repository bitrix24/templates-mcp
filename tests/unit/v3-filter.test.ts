import { describe, expect, it } from 'vitest'
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
