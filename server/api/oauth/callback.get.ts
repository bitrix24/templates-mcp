import { createError, defineEventHandler, deleteCookie, getCookie, getQuery, getRequestURL, setResponseStatus } from 'h3'
import { timingSafeEqualStr } from '~/server/utils/auth-helpers'
import { useLogger } from '~/server/utils/logger'
import { generateCspNonce, htmlEscape, renderBrandStylesTag, renderHostnameDisclosure, setAntiFramingHeaders, setHtmlResponseHeaders } from '~/server/utils/oauth-html'
import { isAllowedPortalDomain } from '~/server/utils/portal-validation'
import { useTokenStore } from '~/server/utils/token-store'

/** Bitrix24 `member_id` is an opaque alnum token; reject anything that
 * isn't, so a compromised upstream can't smuggle a path-traversal or an
 * over-long string into a SQLite primary key + log field. */
const MEMBER_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/

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
  // NOTE: the exchange response also carries `client_endpoint` /
  // `server_endpoint`, but the install path deliberately ignores them —
  // we never persist an endpoint URL; the per-tenant REST endpoint is
  // derived from the validated `portalDomain` at call time
  // (`bitrix24-oauth.ts`). Only the refresh path (where the SDK consumes
  // the endpoints live) validates them, via `portal-validation.ts`. Not
  // declaring them here keeps "what we actually read" honest.
  status?: string
}

interface TokenExchangeErr {
  error: string
  error_description?: string
}

// Header / escape helpers live in `~/server/utils/oauth-html.ts` so this
// route and `/api/oauth/install` share one source of truth (#232 review:
// the two copies had started drifting on CSP directives). Callback omits
// `formAction` — there's no <form> on the success or error pages.


interface CallbackPageOpts {
  /** Per-response nonce for brand-styled rendering (#233); falsy → strict-CSP unstyled. */
  readonly cspNonce: string | undefined
  /** Server's own hostname for the anti-phishing disclosure block. */
  readonly host: string
}

function callbackErrorPage(errorCode: string, detail: string, opts: CallbackPageOpts): string {
  // Tiny HTML — no JS, no external assets. Optional brand stylesheet
  // (#233) is opt-in via the operator's `NUXT_BITRIX24_OAUTH_BRAND_STYLES`
  // flag and ships under a fresh per-response CSP nonce; without it the
  // strict-CSP baseline (`default-src 'none'`) blocks all styling.
  // BOTH interpolated values are escaped: `errorCode` is always a code
  // literal today, but escaping it too is defence-in-depth against a
  // future refactor that passes a Bitrix24-controlled `exchange.error`
  // string into this slot.
  const safeCode = htmlEscape(errorCode)
  const safeDetail = htmlEscape(detail)
  return `<!doctype html><html><head><meta charset="utf-8"><title>OAuth callback failed</title>${renderBrandStylesTag(opts.cspNonce)}</head><body>
<h1>OAuth callback failed</h1>
${renderHostnameDisclosure(opts.host)}
<p>Error code: <code>${safeCode}</code></p>
<p>${safeDetail}</p>
<p>Try again from <a href="/api/oauth/install?portal=&lt;your portal&gt;">/api/oauth/install</a> or contact your operator with the error code above.</p>
</body></html>`
}

function bearerSuccessPage(bearer: string, portal: string, opts: CallbackPageOpts): string {
  // Bearer is shown EXACTLY ONCE. No JS, no copy-to-clipboard helper
  // (would pull in a script-src dependency). Operator pastes manually.
  // The Bearer is `randomBytes(...).toString('hex')` today (no HTML
  // metacharacters), but escape it anyway — defence in depth if the token
  // format ever changes, and the helper is already in scope.
  //
  // NOTE on the `<pre>` below: NO `style=` attribute. Brand styling
  // (#233) lands via the `<style nonce="…">` block in <head>, not via
  // per-element attributes — keeps the strict baseline (no
  // `'unsafe-inline'`) intact.
  const safePortal = htmlEscape(portal)
  const safeBearer = htmlEscape(bearer)
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bitrix24 MCP — Bearer minted</title>${renderBrandStylesTag(opts.cspNonce)}</head><body>
<h1>Your Bitrix24 MCP Bearer</h1>
${renderHostnameDisclosure(opts.host)}
<p>Portal: <code>${safePortal}</code></p>
<p>Copy this token into your MCP client (Claude Desktop / Cursor / Windsurf) <strong>Authorization: Bearer</strong> setting:</p>
<pre>${safeBearer}</pre>
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
    bitrix24OauthBrandStyles,
  } = useRuntimeConfig()
  // Brand-styled landing (#233): mirror the install handler — generate
  // a per-response nonce up-front and pin it on EVERY header path and
  // EVERY HTML render. Strict baseline is preserved when brand styles
  // are off.
  const cspNonce = bitrix24OauthBrandStyles ? generateCspNonce() : undefined
  const host = getRequestURL(event).host
  const headerOpts = { cspNonce }
  const pageOpts = { cspNonce, host }
  // Pin the anti-framing + no-cache headers BEFORE anything else (issue
  // #221). h3 preserves headers across a thrown `createError`, so every
  // deny path below — flag-off, not-configured, params-missing, the six
  // state-* paths — carries `X-Frame-Options: DENY` + the strict CSP
  // without each branch having to remember to call the helper.
  setAntiFramingHeaders(event, headerOpts)

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
  // `consumeState` atomically deletes the row (replay protection) and
  // returns it regardless of expiry, so we can tell "never existed"
  // (STATE-MISSING — possibly a probe) from "expired" (STATE-EXPIRED —
  // a benign slow user). Both are 400; the distinct errorCode + event
  // lets the operator grep one from the other (§11).
  const stateRow = store.consumeState(state)
  if (!stateRow) {
    void logger.warning('oauth.callback.deny.state-missing', { statePrefix: state.slice(0, 8) })
    throw createError({
      statusCode: 400,
      statusMessage: 'state not found',
      data: { errorCode: 'STATE-MISSING' },
    })
  }

  // Strict `<`: a state whose `expiresAt` equals the current second is
  // still accepted (the boundary second is "valid"). `_health`'s
  // `pendingStates` count uses `expires_at > now`, so a row on the exact
  // boundary second is accepted here but not counted as pending there —
  // a one-second cosmetic skew that's irrelevant against the 5-minute
  // TTL, noted so the two comparisons don't look like a bug.
  if (stateRow.expiresAt < Math.floor(Date.now() / 1000)) {
    void logger.info('oauth.callback.deny.state-expired', { statePrefix: state.slice(0, 8) })
    throw createError({
      statusCode: 400,
      statusMessage: 'state expired — restart from /api/oauth/install',
      data: { errorCode: 'STATE-EXPIRED' },
    })
  }

  const cookieValue = getCookie(event, 'bx24_oauth_csrf') ?? ''
  // Defend against a corrupt-DB row with an empty csrf_cookie: install
  // always writes a 64-hex nonce, but the type doesn't guarantee it.
  // Without this guard, `timingSafeEqualStr('', '')` would return true and
  // accept a request that presented NO cookie (the shared helper does not
  // special-case empty input — see its doc comment). Treat an empty
  // persisted value as a hard server error, not a 400.
  if (!stateRow.csrfCookie) {
    void logger.error('oauth.callback.state-row-corrupt', { statePrefix: state.slice(0, 8) })
    throw createError({
      statusCode: 500,
      statusMessage: 'persisted state row has an empty csrf binding',
      data: { errorCode: 'STATE-ROW-CORRUPT' },
    })
  }
  if (!timingSafeEqualStr(cookieValue, stateRow.csrfCookie)) {
    void logger.warning('oauth.callback.deny.state-cookie-mismatch', { statePrefix: state.slice(0, 8) })
    throw createError({
      statusCode: 400,
      statusMessage: 'CSRF cookie does not match state',
      data: { errorCode: 'STATE-COOKIE-MISMATCH' },
    })
  }

  if (!domain) {
    // Bitrix24's marketplace callback usually carries `?domain=`, but not
    // every flow version does. Without it the portal↔callback binding
    // (one of the four §8 CSRF checks) can't be verified — the remaining
    // three (state nonce, CSRF cookie, client_id) still hold. Log it so
    // an operator can spot a flow that's missing the binding.
    void logger.warning('oauth.callback.domain-absent', { statePrefix: state.slice(0, 8) })
  }
  else if (stateRow.portal !== domain.toLowerCase()) {
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
    setHtmlResponseHeaders(event, headerOpts)
    setResponseStatus(event, 502)
    return callbackErrorPage('EXCHANGE-NETWORK', 'Failed to reach Bitrix24 OAuth token endpoint.', pageOpts)
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
    setHtmlResponseHeaders(event, headerOpts)
    setResponseStatus(event, 502)
    return callbackErrorPage('EXCHANGE-NON-JSON', 'Bitrix24 returned a non-JSON response.', pageOpts)
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
    setHtmlResponseHeaders(event, headerOpts)
    // A Bitrix24 5xx is an upstream outage → 503 (retryable); a 4xx /
    // explicit `{error}` is the caller's fault (reused code, wrong
    // client) → 502 (don't tell the client to retry blindly).
    setResponseStatus(event, exchangeRes.status >= 500 ? 503 : 502)
    return callbackErrorPage('EXCHANGE-FAIL', `Bitrix24 refused the token exchange (${errCode}).`, pageOpts)
  }

  const ok = exchange as TokenExchangeOk
  const userIdNum = typeof ok.user_id === 'string' ? Number.parseInt(ok.user_id, 10) : ok.user_id
  if (!Number.isFinite(userIdNum) || userIdNum <= 0) {
    void logger.error('oauth.callback.exchange.fail', { reason: 'bad-user-id', httpStatus: exchangeRes.status })
    setHtmlResponseHeaders(event, headerOpts)
    setResponseStatus(event, 502)
    return callbackErrorPage('EXCHANGE-BAD-USER-ID', 'Bitrix24 returned an unexpected user_id.', pageOpts)
  }

  // Validate member_id before it becomes a SQLite primary key + log
  // field. A compromised DNS / MITM on the token endpoint could return
  // a crafted value; the regex caps length and charset to the real
  // Bitrix24 member_id shape.
  if (typeof ok.member_id !== 'string' || !MEMBER_ID_RE.test(ok.member_id)) {
    void logger.error('oauth.callback.exchange.fail', { reason: 'bad-member-id', httpStatus: exchangeRes.status })
    setHtmlResponseHeaders(event, headerOpts)
    setResponseStatus(event, 502)
    return callbackErrorPage('EXCHANGE-BAD-MEMBER-ID', 'Bitrix24 returned an unexpected member_id.', pageOpts)
  }

  // Defence-in-depth (issue #220): the token-exchange response carries a
  // `domain` field that we previously persisted verbatim. If it disagrees
  // with the `?portal=` the operator authorised — or fails the allow-list —
  // refuse. The validated `stateRow.portal` is the source of truth: it was
  // checked against `PORTAL_ALLOW_LIST_RE` at /install AND bound to the
  // CSRF state row. A divergent `ok.domain` would only happen via a
  // Bitrix24-side bug or an upstream compromise of `oauth.bitrix24.tech`,
  // both of which we refuse loudly rather than silently accept.
  if (ok.domain != null && (!isAllowedPortalDomain(ok.domain) || ok.domain !== stateRow.portal)) {
    void logger.error('oauth.callback.exchange.fail', {
      reason: 'domain-mismatch',
      httpStatus: exchangeRes.status,
      expected: stateRow.portal,
      got: typeof ok.domain === 'string' ? ok.domain.slice(0, 253) : String(ok.domain).slice(0, 253),
    })
    setHtmlResponseHeaders(event, headerOpts)
    setResponseStatus(event, 502)
    return callbackErrorPage('EXCHANGE-DOMAIN-MISMATCH', 'Bitrix24 returned a portal domain that does not match the install.', pageOpts)
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
  // it around. Anti-framing + Cache-Control + Pragma were pinned at the
  // top of the handler; here we only need to flip on the HTML
  // content-type for the success body.
  deleteCookie(event, 'bx24_oauth_csrf', { path: '/api/oauth/' })
  setHtmlResponseHeaders(event, headerOpts)
  return bearerSuccessPage(minted.bearer, stateRow.portal, pageOpts)
})
