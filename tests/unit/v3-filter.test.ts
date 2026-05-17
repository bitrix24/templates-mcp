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

  it('lifts a `!` prefix into the 3-tuple [op, field, value] form', () => {
    expect(toV3Filter({ '!status': 'closed' })).toEqual([['!', 'status', 'closed']])
  })

  it('recognises range operators `>=` / `<=` / `>` / `<`', () => {
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

  it('lifts the `%` LIKE operator', () => {
    expect(toV3Filter({ '%title': 'договор' })).toEqual([['%', 'title', 'договор']])
  })

  it('lifts the `!=` not-equal operator without truncating to `!`', () => {
    // `!=` and `!` are both valid Bitrix24 operators; the longer one must
    // match first or `!=field` would split into `!` + `=field`.
    expect(toV3Filter({ '!=status': 'closed' })).toEqual([['!=', 'status', 'closed']])
  })

  it('returns an empty array for an empty filter', () => {
    expect(toV3Filter({})).toEqual([])
  })

  it('passes through unrecognised prefix-looking keys unchanged', () => {
    // A leading character that isn't a known operator (e.g. `~`) is left as
    // part of the field name — the helper does not invent operators.
    expect(toV3Filter({ '~weird': 1 })).toEqual([['~weird', 1]])
  })

  it('handles a mixed filter end-to-end', () => {
    expect(
      toV3Filter({
        taskId: 7,
        '!status': 'closed',
        '>=createdAt': '2025-01-01',
        '%title': 'q',
      }),
    ).toEqual([
      ['taskId', 7],
      ['!', 'status', 'closed'],
      ['>=', 'createdAt', '2025-01-01'],
      ['%', 'title', 'q'],
    ])
  })
})
