import { describe, expect, it } from 'vitest'
import { pick, toBool, toNumber } from '../../server/utils/wire-coerce'

describe('pick', () => {
  it('returns the camelCase value when present', () => {
    expect(pick({ id: 1, ID: 9 }, 'id', 'ID')).toBe(1)
  })

  it('falls back to UPPERCASE when camelCase is absent', () => {
    expect(pick({ ID: 9 }, 'id', 'ID')).toBe(9)
  })

  it('returns null when neither key is present', () => {
    expect(pick({}, 'id', 'ID')).toBeNull()
  })

  it('returns null when camelCase is undefined and UPPERCASE is absent', () => {
    expect(pick({ id: undefined }, 'id', 'ID')).toBeNull()
  })

  it('falls through to UPPERCASE when camelCase is explicitly null (asymmetry from `??`)', () => {
    // `null ?? upper` returns `upper`. This matches Bitrix24's pattern of
    // shipping `null` for fields it has no v3 data for, while the legacy
    // UPPERCASE field carries the meaningful payload.
    expect(pick({ id: null, ID: 9 }, 'id', 'ID')).toBe(9)
  })

  describe('own-property hardening (issue #22)', () => {
    it('ignores a value reached via the prototype chain', () => {
      // If someone constructs the payload with `Object.create(maliciousProto)`,
      // a lookup that's not own-property-guarded would surface the prototype
      // value as a real wire field.
      const tainted = Object.create({ id: 'evil' }) as Record<string, unknown>
      expect(pick(tainted, 'id', 'ID')).toBeNull()
    })

    it('ignores `__proto__` reached via the prototype chain', () => {
      // `pick(obj, '__proto__', 'X')` against an object with no own
      // `__proto__` would otherwise return `Object.prototype` itself — leaks
      // the prototype object into the response.
      expect(pick({}, '__proto__', 'X')).toBeNull()
    })

    it('still returns the value when the lookup key is an own property', () => {
      // Sanity-check the hardening did not break the happy path —
      // `Object.hasOwn` returns true for the only-own case.
      expect(pick({ id: 1 }, 'id', 'ID')).toBe(1)
    })

    it('falls through to UPPERCASE when the camelCase key sits on the prototype but UPPERCASE is own', () => {
      // The lower lookup must not pick up the prototype value; the upper
      // own-property must win.
      const tainted = Object.assign(Object.create({ id: 'evil' }), { ID: 9 }) as Record<string, unknown>
      expect(pick(tainted, 'id', 'ID')).toBe(9)
    })
  })
})

describe('toNumber', () => {
  it('parses stringified ints', () => {
    expect(toNumber('477')).toBe(477)
  })

  it('passes numbers through unchanged', () => {
    expect(toNumber(42)).toBe(42)
  })

  it('returns null for null / undefined / empty string', () => {
    expect(toNumber(null)).toBeNull()
    expect(toNumber(undefined)).toBeNull()
    expect(toNumber('')).toBeNull()
  })

  it('returns null for non-numeric strings rather than NaN', () => {
    // NaN would round-trip through JSON.stringify as `null` and conflate
    // "missing" with "malformed" downstream.
    expect(toNumber('not-a-number')).toBeNull()
  })

  it('truncates float strings via parseInt (intentional — wire fields are ids)', () => {
    // Documented behaviour: integer-only contract. A float string is
    // unexpected drift from Bitrix24; truncating beats dropping the value
    // entirely.
    expect(toNumber('3.7')).toBe(3)
  })

  it('passes a numeric float through unchanged', () => {
    // Asymmetry vs the string path: parseInt only runs on strings; numbers
    // are checked by isFinite and returned as-is.
    expect(toNumber(3.7)).toBe(3.7)
  })
})

describe('toBool', () => {
  it('returns true only for the literal string "Y"', () => {
    expect(toBool('Y')).toBe(true)
  })

  it('treats unexpected encodings as false', () => {
    expect(toBool('N')).toBe(false)
    expect(toBool(true)).toBe(false)
    expect(toBool(1)).toBe(false)
    expect(toBool('y')).toBe(false)
    expect(toBool(null)).toBe(false)
    expect(toBool(undefined)).toBe(false)
  })
})
