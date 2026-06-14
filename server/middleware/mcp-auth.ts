import { createError, defineEventHandler, getHeader, getRequestURL, setResponseHeader } from 'h3'
import { timingSafeEqualStr } from '~/server/utils/auth-helpers'

// RFC 6750 §3 `realm` for the webhook-mode Bearer challenge. Identifies the
// protection space in the `WWW-Authenticate` header so a spec-following MCP
// client can present the right credential.
const WWW_AUTH_REALM = 'bx24-template-mcp'

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
    // RFC 6750 §3: a 401 from a Bearer-protected resource MUST carry a
    // `WWW-Authenticate: Bearer` challenge. When the request supplied NO
    // credentials at all, the spec says NOT to include an `error` code —
    // just the realm (and optionally `scope`). Spec-following MCP clients
    // use this to discover the auth scheme. The OAuth-on branch above sets
    // its own header with the §11 errorCode taxonomy; webhook mode uses
    // the plain realm challenge.
    setResponseHeader(event, 'www-authenticate', `Bearer realm="${WWW_AUTH_REALM}"`)
    throw createError({ statusCode: 401, statusMessage: 'Missing Authorization header' })
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()

  if (!token || !timingSafeEqualStr(token, expected)) {
    // RFC 6750 §3: credentials WERE supplied but are wrong → include
    // `error="invalid_token"` so the client knows to stop retrying with
    // the same value rather than re-prompting for a missing one.
    setResponseHeader(
      event,
      'www-authenticate',
      `Bearer realm="${WWW_AUTH_REALM}", error="invalid_token", error_description="Invalid bearer token"`,
    )
    throw createError({ statusCode: 401, statusMessage: 'Invalid bearer token' })
  }
})
