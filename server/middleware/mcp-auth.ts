import { Buffer } from 'node:buffer'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'
import { createError, defineEventHandler, getHeader, getRequestURL, setResponseHeader } from 'h3'

export default defineEventHandler((event) => {
  const { pathname } = getRequestURL(event)

  // Only guard /mcp and /mcp/* — paths like /mcphacked must not bypass auth
  // but also must not require it (404 from the router is fine).
  if (pathname !== '/mcp' && !pathname.startsWith('/mcp/')) return

  // When OAuth is on, the toolkit-level middleware in `server/mcp/index.ts`
  // owns Bearer-to-tenant resolution (it also needs to wrap `next()` in an
  // ALS scope, which an h3-level middleware can't do). Defence-in-depth:
  // we don't trust the toolkit middleware to register correctly under
  // HMR or a failing module load — refuse the request HERE if there's
  // no `Authorization: Bearer …` shape at all, then yield for the
  // toolkit middleware to do the actual cryptographic validation. Worst
  // case if the toolkit middleware is missing: requests still get 401,
  // not an auth bypass.
  if (useRuntimeConfig().bitrix24OauthEnabled) {
    const header = getHeader(event, 'authorization')
    if (!header || !/^Bearer\s+\S/i.test(header)) {
      // §11 / RFC 6750 §3: every Bearer-auth 401 carries WWW-Authenticate
      // with the errorCode. This branch fires BEFORE the toolkit
      // middleware in `server/mcp/index.ts` (which sets the same header
      // on its own deny paths), so it must set the header itself —
      // otherwise a no-Bearer request gets a bare 401 and the §11
      // contract is silently broken in production (caught by the #224
      // docker-smoke OAuth-on boot). BEARER-UNKNOWN matches the toolkit
      // middleware's bucket for an absent Bearer: indistinguishable from
      // one that was never minted.
      setResponseHeader(event, 'www-authenticate', 'Bearer error="invalid_token", errorCode="BEARER-UNKNOWN", error_description="Bearer required"')
      throw createError({ statusCode: 401, statusMessage: 'Bearer required', data: { errorCode: 'BEARER-UNKNOWN' } })
    }
    return
  }

  const expected = useRuntimeConfig().mcpAuthToken
  // Treat the `.env.example` placeholder as "not configured": an operator who
  // copied the example without running `openssl rand -hex 32` must not end up
  // with a guessable, publicly-documented token guarding /mcp.
  if (!expected || expected === 'replace-with-secure-token') {
    // Service-unavailable: not configured, not the caller's fault. Surfacing
    // 500 here would leak misconfiguration to anonymous callers.
    throw createError({
      statusCode: 503,
      statusMessage: 'MCP endpoint is not available',
    })
  }

  const header = getHeader(event, 'authorization')
  if (!header) {
    throw createError({ statusCode: 401, statusMessage: 'Missing Authorization header' })
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()

  if (!token || !timingSafeEqual(token, expected)) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid bearer token' })
  }
})

function timingSafeEqual(a: string, b: string): boolean {
  // crypto.timingSafeEqual throws if the buffers differ in length, so length
  // is checked first. Length leak is acceptable: our tokens are fixed-length
  // hex from `openssl rand -hex 32`.
  if (a.length !== b.length) return false
  return cryptoTimingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
