import { describe, expect, it } from 'vitest'
import { AjaxError, SdkError } from '@bitrix24/b24jssdk'
import { Bitrix24ErrorCode, Bitrix24ToolError, toToolError } from '../../server/utils/errors'

describe('toToolError', () => {
  it('returns the same instance when given a Bitrix24ToolError', () => {
    // `'CUSTOM'` is intentionally a raw string, not a registry constant —
    // this test exercises the pass-through escape hatch of the permissive
    // `Bitrix24ErrorCode | string` type, not the registry enumeration.
    const original = new Bitrix24ToolError('boom', 'CUSTOM')
    const wrapped = toToolError(original)
    expect(wrapped).toBe(original)
  })

  it('wraps a generic Error preserving its message', () => {
    const wrapped = toToolError(new Error('network down'))
    expect(wrapped).toBeInstanceOf(Bitrix24ToolError)
    expect(wrapped.message).toBe('network down')
    expect(wrapped.code).toBe(Bitrix24ErrorCode.BITRIX24_ERROR)
  })

  it('lifts a numeric/string code property from the source error', () => {
    const err = Object.assign(new Error('not found'), { code: 'NOT_FOUND' })
    const wrapped = toToolError(err)
    expect(wrapped.code).toBe('NOT_FOUND')
  })

  it('falls back to the supplied default for non-Error values', () => {
    const wrapped = toToolError('something', 'fallback message')
    expect(wrapped.message).toBe('fallback message')
    expect(wrapped.code).toBe(Bitrix24ErrorCode.BITRIX24_ERROR)
  })

  it('preserves code AND status when given an AjaxError from the SDK', () => {
    const ajax = new AjaxError({
      code: 'QUERY_LIMIT_EXCEEDED',
      description: 'too many requests',
      status: 503,
    })
    const wrapped = toToolError(ajax)
    expect(wrapped).toBeInstanceOf(Bitrix24ToolError)
    expect(wrapped.code).toBe('QUERY_LIMIT_EXCEEDED')
    expect(wrapped.status).toBe(503)
  })

  it('preserves code AND status when given a generic SdkError', () => {
    const sdk = new SdkError({ code: 'AUTH_INVALID', description: 'bad webhook', status: 401 })
    const wrapped = toToolError(sdk)
    expect(wrapped.code).toBe('AUTH_INVALID')
    expect(wrapped.status).toBe(401)
  })
})

describe('Bitrix24ErrorCode registry', () => {
  it('exposes every code we throw from project utilities', () => {
    // Pin the catalogue so dropping a code is a visible test failure, not
    // a silent regression. SDK-passed codes (QUERY_LIMIT_EXCEEDED,
    // ACCESS_DENIED, OPERATION_TIME_LIMIT, BITRIX_REST_V3_EXCEPTION_*…) are
    // intentionally NOT enumerated — they pass through `toToolError` as
    // strings via the permissive `Bitrix24ErrorCode | string` type.
    expect(Object.keys(Bitrix24ErrorCode).sort()).toEqual([
      'BATCH_TOO_LARGE',
      'BITRIX24_ERROR',
      'DELETE_NEEDS_CONFIRM',
      'HEADING_DELETE_NEEDS_CONFIRM',
      'INVALID_INPUT',
      'NO_CHANGES',
    ])
  })

  it('uses identical key and value strings (registry is its own catalogue)', () => {
    for (const [key, value] of Object.entries(Bitrix24ErrorCode)) {
      expect(value).toBe(key)
    }
  })
})
