import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 functions are stubbed so we can drive the middleware with synthetic
// events. defineEventHandler becomes the identity function — its only job in
// production is to attach a marker; tests don't need it.
vi.mock('h3', () => ({
  defineEventHandler: <T>(fn: T) => fn,
  getRequestURL: (event: FakeEvent) => new URL(event._url, 'http://test.local'),
  getHeader: (event: FakeEvent, name: string) => event._headers?.[name.toLowerCase()],
  createError: (opts: { statusCode: number; statusMessage: string }) => {
    const err = new Error(opts.statusMessage) as Error & {
      statusCode: number
      statusMessage: string
    }
    err.statusCode = opts.statusCode
    err.statusMessage = opts.statusMessage
    return err
  },
}))

interface FakeEvent {
  _url: string
  _headers?: Record<string, string>
}

const runtimeConfig: { mcpAuthToken: string } = { mcpAuthToken: '' }
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

// h3's defineEventHandler wraps the inner function with markers (__is_event__
// etc.), so the default export's static type is EventHandler. Our mocked
// version (above) is the identity function — at runtime it IS our handler —
// hence the deliberate `as unknown` two-step cast.
const middleware = (await import('../../../server/middleware/mcp-auth'))
  .default as unknown as (event: FakeEvent) => void

function callMiddleware(url: string, headers: Record<string, string> = {}) {
  return () => middleware({ _url: url, _headers: headers })
}

describe('mcp-auth middleware', () => {
  beforeEach(() => {
    runtimeConfig.mcpAuthToken = 'secret-token'
  })

  it('skips paths outside /mcp', () => {
    expect(callMiddleware('/api/health')()).toBeUndefined()
    expect(callMiddleware('/')()).toBeUndefined()
  })

  it('does not guard sibling paths that merely share the /mcp prefix', () => {
    // /mcphacked must not be auth-gated — it's a different route entirely and
    // should reach the router as 404, not be confused with the MCP endpoint.
    expect(callMiddleware('/mcphacked')()).toBeUndefined()
    expect(callMiddleware('/mcp-debug')()).toBeUndefined()
  })

  it('guards /mcp exactly', () => {
    expect(callMiddleware('/mcp')).toThrow(/Missing Authorization/)
  })

  it('guards /mcp/<sub>', () => {
    expect(callMiddleware('/mcp/messages')).toThrow(/Missing Authorization/)
  })

  it('returns 503 when the server token is not configured', () => {
    runtimeConfig.mcpAuthToken = ''
    expect(callMiddleware('/mcp', { authorization: 'Bearer x' })).toThrow(
      expect.objectContaining({ statusCode: 503 }),
    )
  })

  it('returns 503 when the token is left at the .env.example placeholder', () => {
    runtimeConfig.mcpAuthToken = 'replace-with-secure-token'
    expect(
      callMiddleware('/mcp', { authorization: 'Bearer replace-with-secure-token' }),
    ).toThrow(expect.objectContaining({ statusCode: 503 }))
  })

  it('returns 503 for the placeholder token even with no Authorization header (fires before the header check)', () => {
    runtimeConfig.mcpAuthToken = 'replace-with-secure-token'
    expect(callMiddleware('/mcp')).toThrow(expect.objectContaining({ statusCode: 503 }))
  })

  it('rejects a missing Authorization header with 401', () => {
    expect(callMiddleware('/mcp')).toThrow(
      expect.objectContaining({ statusCode: 401, message: 'Missing Authorization header' }),
    )
  })

  it('rejects a malformed Authorization header with 401', () => {
    expect(callMiddleware('/mcp', { authorization: 'secret-token' })).toThrow(
      expect.objectContaining({ statusCode: 401, message: 'Invalid bearer token' }),
    )
  })

  it('rejects a wrong bearer token with 401', () => {
    expect(callMiddleware('/mcp', { authorization: 'Bearer wrong-token' })).toThrow(
      expect.objectContaining({ statusCode: 401, message: 'Invalid bearer token' }),
    )
  })

  it('rejects a token of wrong length', () => {
    expect(callMiddleware('/mcp', { authorization: 'Bearer secret-token-extra' })).toThrow(
      expect.objectContaining({ statusCode: 401 }),
    )
  })

  it('accepts the correct bearer token', () => {
    expect(callMiddleware('/mcp', { authorization: 'Bearer secret-token' })()).toBeUndefined()
  })

  it('accepts case-insensitive Bearer scheme', () => {
    expect(callMiddleware('/mcp', { authorization: 'bearer secret-token' })()).toBeUndefined()
  })

  it('trims surrounding whitespace from the token', () => {
    expect(callMiddleware('/mcp', { authorization: 'Bearer   secret-token  ' })()).toBeUndefined()
  })
})
