import { randomBytes } from 'node:crypto'
import { createError, defineEventHandler, getQuery, getRequestHeader, sendRedirect, setCookie, setResponseHeader } from 'h3'
import type { H3Event } from 'h3'
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
 *   2. **Browser ergonomics (operator UX, follow-up to #221).** If the
 *      caller is a browser (Accept includes `text/html`) and `?portal=`
 *      is missing, render a tiny HTML landing form instead of refusing
 *      with a 400. Lets a non-technical operator visit
 *      `/api/oauth/install` directly and fill in their portal hostname
 *      rather than learning how to construct a query string. CLI and
 *      `Accept: application/json` callers are unchanged: the form
 *      branch never fires for them, so `manual-qa-pr2c.sh` and every
 *      automated probe keeps its byte-identical contract. Same posture
 *      applies to the deny branches below — browsers get a friendly
 *      HTML page with a retry link; CLIs get the JSON throw.
 *   3. Validates `?portal=` against `PORTAL_ALLOW_LIST_RE` — prevents the
 *      endpoint from being used as an open redirector. Anything failing
 *      the regex gets a 400 with errorCode `PORTAL-FORMAT` (logged
 *      `oauth.install.deny.portal-format`).
 *   4. Generates a 32-byte hex CSRF state nonce + a separate 32-byte hex
 *      cookie value. Persists `(state, portal, clientId, csrfCookie,
 *      expiresAt)` via the token store with a 5-minute TTL so an
 *      in-flight install survives a Nitro restart (§8 #2).
 *   5. Sets a first-party `HttpOnly; Secure; SameSite=Lax` cookie
 *      scoped to `/api/oauth/` so it only reaches the install + callback
 *      routes (and never a tool / agent surface).
 *   6. Redirects (302) to `https://<portal>/oauth/authorize/?...` with
 *      `client_id`, `state`, `redirect_uri`, `scope`.
 *
 * Logging (PR-2c step 3 of §11 taxonomy):
 *   - `oauth.install.start` (INFO, on entry — `portal`, `clientId`)
 *   - `oauth.install.deny.portal-format` (WARN — failed regex)
 *   - `oauth.install.deny.flag-off` (WARN — flag disabled)
 *   - `oauth.install.deny.not-configured` (WARN — clientId/redirect missing)
 *   - `oauth.install.landing` (DEBUG — browser hit the route with no
 *     `?portal=`; the form was rendered. Doesn't mint state or set
 *     cookies. Quiet on purpose — operators expect every browser open
 *     to leave a noisy INFO trail otherwise)
 *   - `oauth.install.ok` (INFO — state minted, redirect issued; logs only
 *     the first 8 hex chars of `state` per §11 debug-trace policy)
 *
 * The error code surfaced to the caller mirrors §11's taxonomy — the
 * suffix after the last dot, uppercased (`PORTAL-FORMAT` etc.) — so an
 * operator grep on the log matches the same string a user would paste
 * into support.
 */

const NONCE_BYTES = 32
const STATE_TTL_SEC = 5 * 60 // 5 minutes per §8 #2

function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString('hex')
}

/**
 * `true` when the caller's `Accept` header includes `text/html` — a
 * browser navigation. Default-fail to JSON: a missing Accept (curl,
 * fetch with no header) is the conservative CLI assumption, so the
 * landing form / HTML error pages never accidentally swallow an
 * automated probe's 400.
 *
 * A bare wildcard (`star/star`) does NOT count — that's the curl /
 * generic-HTTP fallback, not a browser. We require `text/html` to
 * appear explicitly.
 */
function wantsHtml(event: H3Event): boolean {
  const accept = getRequestHeader(event, 'accept') ?? ''
  return accept.toLowerCase().includes('text/html')
}

/**
 * Anti-framing + anti-cache response headers for EVERY path this route
 * takes (issue #221 + operator-UX follow-up).
 *
 * Same posture as `/api/oauth/callback`'s helper of the same name — see
 * the doc comment there for the per-header rationale. One difference:
 * we add `form-action 'self'` to the CSP because the new landing page
 * carries a `<form>` whose submission must be allowed under the strict
 * `default-src 'none'` base. The callback page has no form and can use
 * the tighter directive set; the install page needs this one extra.
 */
function setAntiFramingHeaders(event: H3Event): void {
  setResponseHeader(event, 'cache-control', 'no-store, no-cache')
  setResponseHeader(event, 'pragma', 'no-cache')
  setResponseHeader(event, 'x-frame-options', 'DENY')
  setResponseHeader(
    event,
    'content-security-policy',
    'default-src \'none\'; frame-ancestors \'none\'; form-action \'self\'',
  )
}

/** HTML render paths additionally pin `content-type: text/html`. */
function setHtmlResponseHeaders(event: H3Event): void {
  setAntiFramingHeaders(event)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
}

function htmlEscape(s: string): string {
  // `?? c` fallback mirrors the callback handler's escape helper —
  // a no-op preserve if the character class and lookup table ever
  // drift, instead of a non-null assertion that lies to the type
  // checker.
  return String(s).replace(/[&<>"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c] ?? c))
}

/**
 * Landing form rendered when a browser hits `/api/oauth/install`
 * without a `?portal=` query. One text input + one submit button +
 * the operator-facing context (scopes that will be requested, the
 * app's `client_id`, what happens after submit).
 *
 * The form submits GET back to the same URL — so the existing
 * server-side allow-list validation is still authoritative. The
 * `pattern` attribute is a CLIENT-side ergonomic hint only: it
 * mirrors `PORTAL_ALLOW_LIST_RE` (anchors stripped — HTML5 `pattern`
 * is implicitly anchored) so a typo is caught before the round trip,
 * but a malicious client can disable client-side validation; the
 * server-side check still runs unconditionally on the next request.
 *
 * No JS, no inline styles, no external assets — the strict CSP set
 * by `setAntiFramingHeaders` would block any of those. Operators who
 * want branding should put a styled wrapper page at `/` on their
 * reverse proxy and link `/api/oauth/install` from it.
 */
function installLandingPage(clientId: string, scope: string): string {
  // Strip the regex anchors for the HTML pattern attribute. The source
  // is `^…$`; HTML5 `pattern` is implicitly anchored so we drop both.
  const portalPattern = PORTAL_ALLOW_LIST_RE.source.replace(/^\^/, '').replace(/\$$/, '')
  const safePattern = htmlEscape(portalPattern)
  const safeClientId = htmlEscape(clientId)
  const scopeItems = scope.split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => `<li><code>${htmlEscape(s)}</code></li>`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bitrix24 MCP — Connect your portal</title></head><body>
<h1>Connect your Bitrix24 portal</h1>
<p>This MCP server will act on your behalf in your Bitrix24 portal. You'll be redirected to your portal to confirm, then back to this server to copy a Bearer token into your MCP client.</p>
<form action="/api/oauth/install" method="get" autocomplete="off">
<label for="portal">Portal hostname</label>
<input type="text" id="portal" name="portal" placeholder="acme.bitrix24.com" pattern="${safePattern}" required autofocus>
<button type="submit">Authorize on Bitrix24</button>
</form>
<h2>What happens next</h2>
<ol>
<li>You'll be redirected to <code>https://&lt;your-portal&gt;/oauth/authorize/</code> to grant access.</li>
<li>Bitrix24 redirects back to this server with a one-time code.</li>
<li>You'll see your Bearer token <strong>once</strong>. Copy it into your MCP client's <code>Authorization: Bearer</code> setting.</li>
</ol>
<h2>Scopes the server will request</h2>
<ul>${scopeItems}</ul>
<p><small>This server identifies as Bitrix24 application <code>${safeClientId}</code>. If that's not the application your operator told you to expect, stop and check with them before continuing.</small></p>
</body></html>`
}

/**
 * HTML error page for deny branches when the caller is a browser.
 * Shows the same `errorCode` that goes into the JSON `data.errorCode`
 * field for CLI callers, so an operator grepping logs sees the same
 * string a user pasted into support.
 *
 * The optional `retry` flag adds a "← Start over" link back to the
 * landing form. Set it on user-recoverable errors (PORTAL-FORMAT —
 * the user can retype) and clear it on operator-recoverable ones
 * (FLAG-OFF, NOT-CONFIGURED — retrying loops on the same error).
 */
function installErrorPage(errorCode: string, detail: string, retry: boolean): string {
  const safeCode = htmlEscape(errorCode)
  const safeDetail = htmlEscape(detail)
  const retryLink = retry
    ? '<p><a href="/api/oauth/install">&larr; Start over</a></p>'
    : '<p>This needs an operator to fix on the server side — contact them with the error code above.</p>'
  return `<!doctype html><html><head><meta charset="utf-8"><title>OAuth install failed</title></head><body>
<h1>OAuth install failed</h1>
<p>Error code: <code>${safeCode}</code></p>
<p>${safeDetail}</p>
${retryLink}
</body></html>`
}

export default defineEventHandler(async (event) => {
  const logger = useLogger()
  // Pin anti-framing + no-cache on EVERY path: 302 success, the landing
  // form, HTML deny pages, and the JSON `throw createError` throws. h3
  // preserves headers across throws, so the JSON deny responses carry
  // X-Frame-Options + the strict CSP too (uniform contract).
  setAntiFramingHeaders(event)
  const wantHtml = wantsHtml(event)
  const {
    bitrix24OauthEnabled,
    bitrix24OauthClientId,
    bitrix24OauthRedirectUrl,
    bitrix24OauthScope,
  } = useRuntimeConfig()

  // Step 1: flag gate. Even browsers get this — the install link should
  // not be reachable on a webhook-only deploy. The HTML page tells them
  // to ask their operator (not retryable from the user's side).
  if (!bitrix24OauthEnabled) {
    void logger.warning('oauth.install.deny.flag-off', { reason: 'OAuth disabled at runtime' })
    if (wantHtml) {
      setHtmlResponseHeaders(event)
      event.node.res.statusCode = 503
      return installErrorPage(
        'FLAG-OFF',
        'OAuth installation is disabled on this server. The operator needs to enable it before anyone can install.',
        false,
      )
    }
    throw createError({
      statusCode: 503,
      statusMessage: 'oauth disabled',
      data: { errorCode: 'FLAG-OFF' },
    })
  }

  // Step 1b: required-config gate. If the flag is on but CLIENT_ID /
  // REDIRECT_URL are missing, refuse rather than redirect to a broken
  // authorize URL. Operator-fixable, not user-fixable.
  const clientId = String(bitrix24OauthClientId ?? '').trim()
  const redirectUrl = String(bitrix24OauthRedirectUrl ?? '').trim()
  const scope = String(bitrix24OauthScope ?? '').trim() || 'user,task'
  if (!clientId || !redirectUrl) {
    void logger.error('oauth.install.deny.not-configured', {
      hasClientId: !!clientId,
      hasRedirectUrl: !!redirectUrl,
    })
    if (wantHtml) {
      setHtmlResponseHeaders(event)
      event.node.res.statusCode = 503
      return installErrorPage(
        'NOT-CONFIGURED',
        'The operator enabled OAuth but did not finish configuring it. Required environment variables are missing on the server.',
        false,
      )
    }
    throw createError({
      statusCode: 503,
      statusMessage: 'oauth misconfigured',
      data: { errorCode: 'NOT-CONFIGURED' },
    })
  }

  // Step 2: portal allow-list. The `?portal=` value is reflected in the
  // redirect URL, so refusing anything that isn't strictly a Bitrix24
  // hostname prevents the install route being abused as an open
  // redirector.
  const portal = String((getQuery(event).portal ?? '')).trim().toLowerCase()

  // Step 2a (operator UX, follow-up to #221): if a browser hits the
  // route with no `?portal=`, render the landing form instead of
  // refusing with PORTAL-FORMAT. No state minted, no cookie set — pure
  // GET render. CLI callers (no `text/html` in Accept) still drop
  // through to the unchanged 400 path so smoke probes are byte-identical.
  if (!portal && wantHtml) {
    void logger.debug('oauth.install.landing', { clientId })
    setHtmlResponseHeaders(event)
    return installLandingPage(clientId, scope)
  }

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
    if (wantHtml) {
      setHtmlResponseHeaders(event)
      event.node.res.statusCode = 400
      return installErrorPage(
        'PORTAL-FORMAT',
        'The portal hostname you entered is not in the accepted format. It must look like ‘acme.bitrix24.com’ (TLDs allowed: com, ru, eu, de, by, kz, ua).',
        true,
      )
    }
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
