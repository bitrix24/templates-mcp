import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 functions are stubbed so we can drive the middleware with synthetic
// events. defineEventHandler becomes the identity function — its only job in
// production is to attach a marker; tests don't need it.
vi.mock('h3', () => ({
  defineEventHandler: <T>(fn: T) => fn,
  getRequestURL: (event: FakeEvent) => new URL(event._url, 'http://test.local'),
  getHeader: (event: FakeEvent, name: string) => event._headers?.[name.toLowerCase()],
  setResponseHeader: (event: FakeEvent, name: string, value: string) => {
    event._responseHeaders ??= {}
    event._responseHeaders[name.toLowerCase()] = value
  },
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
  _responseHeaders?: Record<string, string>
}

const runtimeConfig: { mcpAuthToken: string; bitrix24OauthEnabled: boolean } = {
  mcpAuthToken: '',
  bitrix24OauthEnabled: false,
}
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
    runtimeConfig.bitrix24OauthEnabled = false
  })

  it('yields when NUXT_BITRIX24_OAUTH_ENABLED=true AND the request carries a Bearer header (toolkit middleware owns auth)', () => {
    // PR-2c-bearer (#217): when OAuth is on, this h3-level middleware
    // skips so the `server/mcp/index.ts` toolkit middleware can do the
    // Bearer-to-tenant resolution (it also wraps next() in an ALS scope,
    // which h3 middleware can't).
    runtimeConfig.bitrix24OauthEnabled = true
    runtimeConfig.mcpAuthToken = '' // even with no MCP_AUTH_TOKEN
    expect(callMiddleware('/mcp', { authorization: 'Bearer abc' })()).toBeUndefined()
    expect(callMiddleware('/mcp/messages', { authorization: 'Bearer abc' })()).toBeUndefined()
  })

  it('flag=true defence-in-depth: refuses 401 here if no Bearer header (in case toolkit middleware fails to register)', () => {
    // Security round-4 finding: yielding unconditionally when the flag
    // is on means a missing/broken toolkit middleware leaves /mcp open.
    // This h3 layer requires AT LEAST the `Authorization: Bearer …`
    // shape before yielding — worst case a missing toolkit middleware
    // still produces 401, not an auth bypass.
    runtimeConfig.bitrix24OauthEnabled = true
    expect(callMiddleware('/mcp')).toThrow(/Bearer required/)
    expect(callMiddleware('/mcp', { authorization: 'Basic xyz' })).toThrow(/Bearer required/)
    expect(callMiddleware('/mcp', { authorization: 'Bearer ' })).toThrow(/Bearer required/)
  })

  it('flag=true no-Bearer 401 carries the §11 WWW-Authenticate header (RFC 6750)', () => {
    // Caught by the #224 docker-smoke OAuth-on boot: this h3 branch fires
    // BEFORE the toolkit middleware, so without setting the header itself
    // the production no-Bearer 401 ships bare — breaking the §11 promise
    // that every Bearer-auth 401 is grep-able by errorCode.
    runtimeConfig.bitrix24OauthEnabled = true
    const event: FakeEvent = { _url: '/mcp', _headers: {} }
    expect(() => middleware(event)).toThrow(/Bearer required/)
    expect(event._responseHeaders?.['www-authenticate']).toBe(
      'Bearer error="invalid_token", errorCode="BEARER-UNKNOWN", error_description="Bearer required"',
    )
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

  it('webhook-mode missing-header 401 carries WWW-Authenticate: Bearer realm (RFC 6750 §3, #196)', () => {
    // No credentials supplied → realm-only challenge, NO error code per the
    // RFC (an error code is for credentials that were sent but rejected).
    const event: FakeEvent = { _url: '/mcp', _headers: {} }
    expect(() => middleware(event)).toThrow(/Missing Authorization/)
    expect(event._responseHeaders?.['www-authenticate']).toBe('Bearer realm="bx24-template-mcp"')
  })

  it('rejects a malformed Authorization header with 401', () => {
    expect(callMiddleware('/mcp', { authorization: 'secret-token' })).toThrow(
      expect.objectContaining({ statusCode: 401, message: 'Invalid bearer token' }),
    )
  })

  it('webhook-mode invalid-token 401 carries WWW-Authenticate with error="invalid_token" (RFC 6750 §3, #196)', () => {
    // Credentials WERE supplied but rejected → include the error code so a
    // spec-following client stops retrying the same value.
    const event: FakeEvent = { _url: '/mcp', _headers: { authorization: 'Bearer wrong-token' } }
    expect(() => middleware(event)).toThrow(/Invalid bearer token/)
    expect(event._responseHeaders?.['www-authenticate']).toBe(
      'Bearer realm="bx24-template-mcp", error="invalid_token", error_description="Invalid bearer token"',
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
