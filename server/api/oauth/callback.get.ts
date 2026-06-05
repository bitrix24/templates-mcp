import { createError, defineEventHandler, deleteCookie, getCookie, getQuery, setResponseHeader } from 'h3'
import { useLogger } from '~/server/utils/logger'
import { useTokenStore } from '~/server/utils/token-store'

/**
 * OAuth installation callback (`/api/oauth/callback`, design in
 * `docs/OAUTH-DESIGN.md §3` + §8). Bitrix24 redirects the user here
 * after the authorize page; this handler:
 *
 *   1. Reads `?code=`, `?state=`, optional `?domain=` from the URL.
 *   2. Consumes the `oauth_state` row by `state` (atomic single-statement
 *      `DELETE … RETURNING` from PR-2b). Returns `undefined` if the
 *      state is unknown OR expired (5-min TTL); both fail loud.
 *   3. Verifies the persisted `csrfCookie` matches the first-party
 *      cookie set by `/install`. Mismatch → 400.
 *   4. Verifies the persisted `portal` matches `domain` (when supplied
 *      by Bitrix24's callback). Mismatch → 400.
 *   5. Verifies the persisted `clientId` matches the configured client
 *      id. Mismatch → 400 (defensive — a state minted against one
 *      `?portal=` cannot be replayed against another).
 *   6. Exchanges `code` for tokens via `POST oauth.bitrix24.tech/oauth/token/`.
 *      Bitrix24 returns `member_id`, `user_id`, `access_token`,
 *      `refresh_token`, `expires_in`, `domain`, `scope`. Any non-2xx or
 *      `error` field → ERROR + 502.
 *   7. `upsertTokens` (audit-first) writes the row.
 *   8. `createMcpToken` mints a Bearer for that `(member_id, user_id)`.
 *   9. Clears the CSRF cookie + sets `Cache-Control: no-store, no-cache`
 *      + `Pragma: no-cache` so no proxy / browser cache holds the
 *      Bearer.
 *  10. Renders a minimal HTML page showing the Bearer ONCE with
 *      paste instructions.
 *
 * Logging (§11 taxonomy):
 *   - `oauth.callback.start`                  (INFO)
 *   - `oauth.callback.deny.state-missing`     (WARN)
 *   - `oauth.callback.deny.state-cookie-mismatch`  (WARN)
 *   - `oauth.callback.deny.state-portal-mismatch`  (WARN)
 *   - `oauth.callback.deny.state-client-mismatch`  (WARN)
 *   - `oauth.callback.exchange.fail`          (ERROR — `httpStatus`,
 *     `error` code from Bitrix24; NEVER the raw URL or body, those go
 *     through the redactor on their way to the JSONL sink)
 *   - `oauth.callback.exchange.ok`            (INFO)
 *
 * Bearer minting label: the persisted portal is used as a default
 * label so the operator-facing "list my Bearers" follow-up (issue #212)
 * can show "acme.bitrix24.com — Bearer ending in …xyz" without the user
 * having to name it at install time.
 */

const TOKEN_EXCHANGE_URL = 'https://oauth.bitrix24.tech/oauth/token/'

interface TokenExchangeOk {
  access_token: string
  refresh_token: string
  expires_in: number
  expires?: number
  member_id: string
  user_id: number | string
  scope?: string
  domain?: string
  client_endpoint?: string
  status?: string
}

interface TokenExchangeErr {
  error: string
  error_description?: string
}

function callbackErrorPage(errorCode: string, detail: string): string {
  // Tiny HTML — no JS, no external assets, no styling that could pull
  // in resources from another origin. The error code is also sent in
  // the JSON `data.errorCode` field for non-browser callers.
  const safeDetail = String(detail).replace(/[&<>"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]!))
  return `<!doctype html><html><head><meta charset="utf-8"><title>OAuth callback failed</title></head><body>
<h1>OAuth callback failed</h1>
<p>Error code: <code>${errorCode}</code></p>
<p>${safeDetail}</p>
<p>Try again from <a href="/api/oauth/install?portal=&lt;your portal&gt;">/api/oauth/install</a> or contact your operator with the error code above.</p>
</body></html>`
}

function bearerSuccessPage(bearer: string, portal: string): string {
  // Bearer is shown EXACTLY ONCE. No JS, no copy-to-clipboard helper
  // (would pull in a script-src dependency). Operator pastes manually.
  const safePortal = String(portal).replace(/[&<>"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]!))
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bitrix24 MCP — Bearer minted</title></head><body>
<h1>Your Bitrix24 MCP Bearer</h1>
<p>Portal: <code>${safePortal}</code></p>
<p>Copy this token into your MCP client (Claude Desktop / Cursor / Windsurf) <strong>Authorization: Bearer</strong> setting:</p>
<pre style="word-wrap:break-word;white-space:pre-wrap;padding:1em;background:#eee;border-radius:4px">${bearer}</pre>
<p><strong>This page is shown once.</strong> The token is hashed in the database; the raw value above cannot be re-displayed. Lost it? Re-authorize from <code>/api/oauth/install?portal=${safePortal}</code> — your old Bearer keeps working until you revoke it.</p>
</body></html>`
}

export default defineEventHandler(async (event) => {
  const logger = useLogger()
  const {
    bitrix24OauthEnabled,
    bitrix24OauthClientId,
    bitrix24OauthClientSecret,
    bitrix24OauthRedirectUrl,
  } = useRuntimeConfig()

  if (!bitrix24OauthEnabled) {
    void logger.warning('oauth.callback.deny.flag-off')
    throw createError({ statusCode: 503, statusMessage: 'oauth disabled', data: { errorCode: 'FLAG-OFF' } })
  }

  const clientId = String(bitrix24OauthClientId ?? '').trim()
  const clientSecret = String(bitrix24OauthClientSecret ?? '').trim()
  const redirectUrl = String(bitrix24OauthRedirectUrl ?? '').trim()
  if (!clientId || !clientSecret || !redirectUrl) {
    void logger.error('oauth.callback.deny.not-configured', {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      hasRedirectUrl: !!redirectUrl,
    })
    throw createError({ statusCode: 503, statusMessage: 'oauth misconfigured', data: { errorCode: 'NOT-CONFIGURED' } })
  }

  const query = getQuery(event)
  const code = typeof query.code === 'string' ? query.code : ''
  const state = typeof query.state === 'string' ? query.state : ''
  const domain = typeof query.domain === 'string' ? query.domain : ''
  void logger.info('oauth.callback.start', {
    // Never log `code` — it's an authorization-grant secret. State is a
    // CSRF nonce, only the first 8 hex chars per §11 debug-trace policy.
    statePrefix: state.slice(0, 8),
    domain: domain || '<not-provided>',
  })

  if (!code || !state) {
    void logger.warning('oauth.callback.deny.params-missing', { hasCode: !!code, hasState: !!state })
    throw createError({
      statusCode: 400,
      statusMessage: 'callback missing code or state',
      data: { errorCode: 'PARAMS-MISSING' },
    })
  }

  const store = useTokenStore()
  const stateRow = store.consumeState(state)
  if (!stateRow) {
    void logger.warning('oauth.callback.deny.state-missing', { statePrefix: state.slice(0, 8) })
    throw createError({
      statusCode: 400,
      statusMessage: 'state not found or expired',
      data: { errorCode: 'STATE-MISSING' },
    })
  }

  const cookieValue = getCookie(event, 'bx24_oauth_csrf') ?? ''
  if (cookieValue !== stateRow.csrfCookie) {
    void logger.warning('oauth.callback.deny.state-cookie-mismatch', { statePrefix: state.slice(0, 8) })
    throw createError({
      statusCode: 400,
      statusMessage: 'CSRF cookie does not match state',
      data: { errorCode: 'STATE-COOKIE-MISMATCH' },
    })
  }

  if (domain && stateRow.portal !== domain.toLowerCase()) {
    void logger.warning('oauth.callback.deny.state-portal-mismatch', {
      expected: stateRow.portal,
      got: domain,
    })
    throw createError({
      statusCode: 400,
      statusMessage: 'portal mismatch between install and callback',
      data: { errorCode: 'STATE-PORTAL-MISMATCH' },
    })
  }

  if (stateRow.clientId !== clientId) {
    // Defensive — the install endpoint persists the current clientId.
    // Mismatch means the operator rotated CLIENT_ID between /install
    // and /callback, OR a state minted against one app is being
    // replayed against another. Either way: refuse.
    void logger.warning('oauth.callback.deny.state-client-mismatch')
    throw createError({
      statusCode: 400,
      statusMessage: 'client_id mismatch between install and callback',
      data: { errorCode: 'STATE-CLIENT-MISMATCH' },
    })
  }

  // Step 6: token exchange. Bitrix24's OAuth token endpoint accepts a
  // GET (query string) or POST (form-urlencoded); we use POST so the
  // `client_secret` doesn't appear in any URL-shaped log line even by
  // accident.
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUrl,
  })

  let exchangeRes: Response
  try {
    exchangeRes = await fetch(TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
  }
  catch (err) {
    void logger.error('oauth.callback.exchange.fail', {
      reason: 'network',
      message: (err as Error).message,
    })
    setResponseHeader(event, 'cache-control', 'no-store, no-cache')
    setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
    event.node.res.statusCode = 502
    return callbackErrorPage('EXCHANGE-NETWORK', 'Failed to reach Bitrix24 OAuth token endpoint.')
  }

  // Parse defensively — error responses may be JSON or HTML depending
  // on Bitrix24's load balancer state.
  let exchange: TokenExchangeOk | TokenExchangeErr
  try {
    exchange = await exchangeRes.json() as TokenExchangeOk | TokenExchangeErr
  }
  catch {
    void logger.error('oauth.callback.exchange.fail', {
      reason: 'non-json',
      httpStatus: exchangeRes.status,
    })
    setResponseHeader(event, 'cache-control', 'no-store, no-cache')
    setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
    event.node.res.statusCode = 502
    return callbackErrorPage('EXCHANGE-NON-JSON', 'Bitrix24 returned a non-JSON response.')
  }

  if (!exchangeRes.ok || 'error' in exchange) {
    const errCode = (exchange as TokenExchangeErr).error || `http-${exchangeRes.status}`
    void logger.error('oauth.callback.exchange.fail', {
      reason: 'bitrix24-error',
      httpStatus: exchangeRes.status,
      error: errCode,
      // No description — could contain user-supplied or URL-shaped data.
      // Operator inspects the audit log + `_health` for the timeline.
    })
    setResponseHeader(event, 'cache-control', 'no-store, no-cache')
    setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
    event.node.res.statusCode = 502
    return callbackErrorPage('EXCHANGE-FAIL', `Bitrix24 refused the token exchange (${errCode}).`)
  }

  const ok = exchange as TokenExchangeOk
  const userIdNum = typeof ok.user_id === 'string' ? Number.parseInt(ok.user_id, 10) : ok.user_id
  if (!Number.isFinite(userIdNum) || userIdNum <= 0) {
    void logger.error('oauth.callback.exchange.fail', { reason: 'bad-user-id', httpStatus: exchangeRes.status })
    setResponseHeader(event, 'cache-control', 'no-store, no-cache')
    setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
    event.node.res.statusCode = 502
    return callbackErrorPage('EXCHANGE-BAD-USER-ID', 'Bitrix24 returned an unexpected user_id.')
  }

  const accessExpiresAt = ok.expires
    ?? Math.floor(Date.now() / 1000) + (ok.expires_in ?? 3600)

  await store.upsertTokens({
    memberId: ok.member_id,
    userId: userIdNum,
    portalDomain: ok.domain ?? stateRow.portal,
    accessToken: ok.access_token,
    refreshToken: ok.refresh_token,
    accessExpiresAt,
    scope: ok.scope ?? '',
  }, 'install')

  const minted = await store.createMcpToken(ok.member_id, userIdNum, stateRow.portal, 'install')

  void logger.info('oauth.callback.exchange.ok', {
    memberId: ok.member_id,
    userId: userIdNum,
    bearerHashPrefix: minted.bearerHash.slice(0, 15), // 'sha256-' + 8 hex = 15 chars, enough to identify, useless as a credential
    portal: stateRow.portal,
  })

  // Clean up: drop the CSRF cookie so subsequent traffic doesn't carry
  // it around. `Cache-Control: no-store, no-cache` keeps the Bearer
  // out of any proxy / CDN cache; `Pragma: no-cache` for HTTP/1.0
  // proxies (uncommon but cheap to be defensive).
  deleteCookie(event, 'bx24_oauth_csrf', { path: '/api/oauth/' })
  setResponseHeader(event, 'cache-control', 'no-store, no-cache')
  setResponseHeader(event, 'pragma', 'no-cache')
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return bearerSuccessPage(minted.bearer, stateRow.portal)
})
