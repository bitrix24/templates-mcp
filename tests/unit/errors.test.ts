import { describe, expect, it } from 'vitest'
import { AjaxError, SdkError } from '@bitrix24/b24jssdk'
import { Bitrix24ToolError, toToolError } from '../../server/utils/errors'

describe('toToolError', () => {
  it('returns the same instance when given a Bitrix24ToolError', () => {
    const original = new Bitrix24ToolError('boom', 'CUSTOM')
    const wrapped = toToolError(original)
    expect(wrapped).toBe(original)
  })

  it('wraps a generic Error preserving its message', () => {
    const wrapped = toToolError(new Error('network down'))
    expect(wrapped).toBeInstanceOf(Bitrix24ToolError)
    expect(wrapped.message).toBe('network down')
    expect(wrapped.code).toBe('BITRIX24_ERROR')
  })

  it('lifts a numeric/string code property from the source error', () => {
    const err = Object.assign(new Error('not found'), { code: 'NOT_FOUND' })
    const wrapped = toToolError(err)
    expect(wrapped.code).toBe('NOT_FOUND')
  })

  it('falls back to the supplied default for non-Error values', () => {
    const wrapped = toToolError('something', 'fallback message')
    expect(wrapped.message).toBe('fallback message')
    expect(wrapped.code).toBe('BITRIX24_ERROR')
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
