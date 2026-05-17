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

  it('matches longer prefixes first (`!=` does not truncate to `!`, `>=` does not truncate to `>`)', () => {
    expect(toV3Filter({ '!=status': 'closed' })).toEqual([['<>', 'status', 'closed']])
    expect(toV3Filter({ '>=created': 1 })).toEqual([['>=', 'created', 1]])
  })

  it('returns an empty array for an empty filter', () => {
    expect(toV3Filter({})).toEqual([])
  })

  it('passes through unrecognised prefix-looking keys unchanged', () => {
    // A leading character that isn't a known operator (e.g. `~`) is left as
    // part of the field name — the helper does not invent operators.
    expect(toV3Filter({ '~weird': 1 })).toEqual([['~weird', 1]])
  })

  it('handles null and array values without coercing them', () => {
    expect(toV3Filter({ taskId: null, tags: [1, 2] })).toEqual([
      ['taskId', null],
      ['tags', [1, 2]],
    ])
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
