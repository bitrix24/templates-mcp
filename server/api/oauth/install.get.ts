import { randomBytes } from 'node:crypto'
import { createError, defineEventHandler, getQuery, sendRedirect, setCookie, setResponseHeader } from 'h3'
import { useLogger } from '~/server/utils/logger'
import { PORTAL_ALLOW_LIST_RE } from '~/server/utils/portal-validation'
import { useTokenStore } from '~/server/utils/token-store'

/**
 * OAuth installation entry point (`/api/oauth/install?portal=<host>`,
 * design in `docs/OAUTH-DESIGN.md §3` and §8 #2/#3).
 *
 * What this route does:
 *   1. Refuses when `NUXT_BITRIX24_OAUTH_ENABLED=false` (503 — operator
 *      configured the OAuth surface but flipped the flag back off; the
 *      install link should not be reachable in that state).
 *   2. Validates `?portal=` against `PORTAL_ALLOW_LIST_RE` — prevents the
 *      endpoint from being used as an open redirector. Anything failing
 *      the regex gets a 400 with errorCode `PORTAL-FORMAT` (logged
 *      `oauth.install.deny.portal-format`).
 *   3. Generates a 32-byte hex CSRF state nonce + a separate 32-byte hex
 *      cookie value. Persists `(state, portal, clientId, csrfCookie,
 *      expiresAt)` via the token store with a 5-minute TTL so an
 *      in-flight install survives a Nitro restart (§8 #2).
 *   4. Sets a first-party `HttpOnly; Secure; SameSite=Lax` cookie
 *      scoped to `/api/oauth/` so it only reaches the install + callback
 *      routes (and never a tool / agent surface).
 *   5. Redirects (302) to `https://<portal>/oauth/authorize/?...` with
 *      `client_id`, `state`, `redirect_uri`, `scope`.
 *
 * Logging (PR-2c step 3 of §11 taxonomy):
 *   - `oauth.install.start` (INFO, on entry — `portal`, `clientId`)
 *   - `oauth.install.deny.portal-format` (WARN — failed regex)
 *   - `oauth.install.deny.flag-off` (WARN — flag disabled)
 *   - `oauth.install.deny.not-configured` (WARN — clientId/redirect missing)
 *   - `oauth.install.ok` (INFO — state minted, redirect issued; logs only
 *     the first 8 hex chars of `state` per §11 debug-trace policy)
 *
 * The error code surfaced to the caller mirrors §11's taxonomy — the
 * suffix after the last dot, uppercased (`PORTAL-FORMAT` etc.) — so an
 * operator grep on the log matches the same string a user would paste
 * into support.
 */

/**
 * Allow-list regex matching the conservative TLD set from `OAUTH-DESIGN.md
 * §8 #3`. Forks deploying against a TLD not in this list (e.g.
 * `bitrix24.com.br`) need to expand the regex and the matching list in
 * `.env.example`'s portal-URL examples. We keep the regex conservative
 * here rather than permissive: an open redirector via `?portal=` is a
 * higher-cost mistake than rejecting a legitimate-but-unlisted TLD.
 *
 * The regex itself lives in `~/server/utils/portal-validation.ts` so the
 * callback handler and the OAuth refresh path share the same rule — see
 * issue #220.
 */

const NONCE_BYTES = 32
const STATE_TTL_SEC = 5 * 60 // 5 minutes per §8 #2

function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex')
}

export default defineEventHandler(async (event) => {
  const logger = useLogger()
  // Cache-Control on EVERY path (issue #221 follow-up from CTO review):
  // a 400 PORTAL-FORMAT or 503 FLAG-OFF / NOT-CONFIGURED response could
  // otherwise be cached by an upstream proxy / CDN and pinned to the IP
  // of whoever first triggered it. Cheap defence; harmless on the 302
  // success path (Set-Cookie isn't cached by well-behaved proxies anyway).
  setResponseHeader(event, 'cache-control', 'no-store')
  const {
    bitrix24OauthEnabled,
    bitrix24OauthClientId,
    bitrix24OauthRedirectUrl,
    bitrix24OauthScope,
  } = useRuntimeConfig()

  // Step 1: flag gate. The install link should not be reachable on a
  // webhook-only deploy — failing loud here catches the case where the
  // operator linked /api/oauth/install in their docs but flipped the
  // flag back off (e.g. during a rollback per §10).
  if (!bitrix24OauthEnabled) {
    void logger.warning('oauth.install.deny.flag-off', { reason: 'OAuth disabled at runtime' })
    throw createError({
      statusCode: 503,
      statusMessage: 'oauth disabled',
      data: { errorCode: 'FLAG-OFF' },
    })
  }

  // Step 1b: required-config gate. If `bitrix24OauthEnabled=true` but
  // CLIENT_ID / REDIRECT_URL are missing, refuse rather than redirect to
  // a broken authorize URL (which would 400 on the Bitrix24 side with a
  // confusing error). Operator configured the flag without filling in
  // the rest — the missing-config error names the variable.
  const clientId = String(bitrix24OauthClientId ?? '').trim()
  const redirectUrl = String(bitrix24OauthRedirectUrl ?? '').trim()
  const scope = String(bitrix24OauthScope ?? '').trim() || 'user,task'
  if (!clientId || !redirectUrl) {
    void logger.error('oauth.install.deny.not-configured', {
      hasClientId: !!clientId,
      hasRedirectUrl: !!redirectUrl,
    })
    throw createError({
      statusCode: 503,
      statusMessage: 'oauth misconfigured',
      data: { errorCode: 'NOT-CONFIGURED' },
    })
  }

  // Step 2: portal allow-list. The `?portal=` value is reflected in the
  // redirect URL, so refusing anything that isn't strictly a Bitrix24
  // hostname prevents the install route being abused as an open
  // redirector (a generic phishing primitive that doesn't even need an
  // OAuth account on the target host).
  const portal = String((getQuery(event).portal ?? '')).trim().toLowerCase()
  // Log a SANITISED, CAPPED copy of the raw value (issue #221): `?portal=`
  // is attacker-supplied and logged before validation. The strip covers
  // three threat classes (mirrors `HOSTILE_CHARS` in `github-feedback.ts`
  // so the two ingress points apply the same defence):
  //   - C0 controls + DEL + C1: a plain-text log sink would otherwise
  //     let a crafted portal inject extra log lines or recolour the
  //     operator's terminal (ANSI escapes).
  //   - Unicode bidi overrides (U+202A-U+202E, U+2066-U+2069): visually
  //     reverses the displayed log line, hiding the real portal — the
  //     Trojan Source vector against the operator's log viewer.
  //   - Zero-width / BOM (U+200B-U+200D, U+FEFF): silently splits a
  //     hostname so a grep for `evil.bitrix24.com` misses a logged
  //     `evil.bitrix24<ZWSP>.com`.
  // Cap at 253 (max DNS hostname length, the same cap the audit log
  // applies via MAX_PORTAL_LEN).
  // eslint-disable-next-line no-control-regex -- strip C0 + DEL + C1 + Bidi overrides + zero-widths + BOM (mirrors HOSTILE_CHARS in github-feedback.ts)
  const portalForLog = (portal || '<empty>').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g, '?').slice(0, 253)
  void logger.info('oauth.install.start', { portal: portalForLog, clientId })

  if (!portal || !PORTAL_ALLOW_LIST_RE.test(portal)) {
    void logger.warning('oauth.install.deny.portal-format', { portal: portalForLog })
    throw createError({
      statusCode: 400,
      statusMessage: `portal hostname rejected: must match ${PORTAL_ALLOW_LIST_RE.source}`,
      data: { errorCode: 'PORTAL-FORMAT' },
    })
  }

  // Step 3: mint state + cookie. Two independent 32-byte hex nonces:
  // `state` survives in SQLite (so the callback can verify after a
  // process restart), `csrfCookie` is the value bound into the
  // first-party cookie (§8 #2 — both must match on /callback).
  const state = newNonce()
  const csrfCookie = newNonce()
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_TTL_SEC

  useTokenStore().createState({
    state,
    portal,
    clientId,
    csrfCookie,
    expiresAt,
  })

  // Step 4: set the CSRF cookie. `SameSite=Lax` is correct here — the
  // redirect to Bitrix24 is a top-level navigation, then Bitrix24
  // redirects back to /callback with a GET, which Lax permits. `HttpOnly`
  // keeps JS in the operator's domain from reading it; `Secure` requires
  // HTTPS (the design assumes a TLS-terminating reverse proxy per §10).
  // Path is scoped so the cookie only reaches the install + callback
  // surface, never the MCP `/mcp` endpoint or any tool route.
  setCookie(event, 'bx24_oauth_csrf', csrfCookie, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/api/oauth/',
    maxAge: STATE_TTL_SEC,
  })

  // Step 5: build authorize URL + redirect. Bitrix24's authorize endpoint
  // lives on the portal host itself — `<portal>/oauth/authorize/` —
  // documented at `apidocs.bitrix24.ru/api-reference/oauth/`. We pass
  // `client_id`, `state`, `redirect_uri`, `scope`. The `response_type=code`
  // is implicit in the marketplace-app flow.
  const authorizeUrl = new URL(`https://${portal}/oauth/authorize/`)
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('state', state)
  authorizeUrl.searchParams.set('redirect_uri', redirectUrl)
  authorizeUrl.searchParams.set('scope', scope)
  authorizeUrl.searchParams.set('response_type', 'code')

  void logger.info('oauth.install.ok', {
    portal,
    clientId,
    // First 8 chars only (debug-trace policy in §11) — the full nonce is
    // a secret bound to the in-flight CSRF check.
    statePrefix: state.slice(0, 8),
  })

  await sendRedirect(event, authorizeUrl.toString(), 302)
})
