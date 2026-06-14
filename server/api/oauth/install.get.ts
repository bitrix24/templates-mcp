import { randomBytes } from 'node:crypto'
import { createError, defineEventHandler, getQuery, getRequestHeader, getRequestIP, getRequestURL, sendRedirect, setCookie, setResponseStatus } from 'h3'
import type { H3Event } from 'h3'
import { useLogger } from '~/server/utils/logger'
import { generateCspNonce, htmlEscape, renderBrandStylesTag, renderHostnameDisclosure, setAntiFramingHeaders, setHtmlResponseHeaders } from '~/server/utils/oauth-html'
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
 *   - `oauth.install.deny.not-configured` (ERROR — clientId/redirect missing)
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
 * Path the landing form's GET submission is allowed to target under the
 * CSP `form-action` directive. Sized down from `'self'` (#232 review):
 * any other endpoint on the same origin can't be the target of a form
 * post under the resulting policy — minimal-privilege principle.
 *
 * CSP Level 2 supports path-level form-action; all browsers MCP cares
 * about (Chrome ≥40, Firefox ≥31, Safari ≥10) implement it.
 */
const INSTALL_PATH = '/api/oauth/install'

/**
 * `true` when the caller's `Accept` header includes `text/html` — a
 * browser navigation. Default-fail to JSON: a missing Accept (curl,
 * fetch with no header), the curl-default bare wildcard
 * (`star-slash-star`), and any machine-readable value
 * (`application/json`, `application/xml`) all resolve to false, so
 * automated CLI probes never accidentally get an HTML response. We
 * require the literal substring `text/html` to be present.
 *
 * Q-factor weights (`text/html;q=0.001`) are deliberately NOT parsed:
 * a probe asking for HTML "if absolutely nothing else is available"
 * still asks for HTML, and the simpler `includes` check has one less
 * thing to get wrong. A misbehaving probe can always pin the contract
 * with an explicit `Accept: application/json`.
 */
function wantsHtml(event: H3Event): boolean {
  const accept = getRequestHeader(event, 'accept') ?? ''
  return accept.toLowerCase().includes('text/html')
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
 * reverse proxy and link `/api/oauth/install` from it. (Tracked as a
 * follow-up: optional `style-src` carve-out for an in-page brand — see
 * the open issue linked from `docs/OAUTH-DESIGN.md` §3.)
 */
interface LandingOpts {
  /** When set, emits brand styles under this nonce + uses display name in heading (#233). */
  readonly cspNonce: string | undefined
  /** Operator-supplied via `NUXT_BITRIX24_OAUTH_APP_DISPLAY_NAME`; replaces the default heading when non-empty. */
  readonly displayName: string
  /** Server's own hostname for the anti-phishing disclosure. Always rendered, escape applied in the helper. */
  readonly host: string
}

function installLandingPage(clientId: string, scope: string, opts: LandingOpts): string {
  // Strip the regex anchors for the HTML pattern attribute. The source
  // is `^…$`; HTML5 `pattern` is implicitly anchored so we drop both.
  // `safePattern` is interpolated into a DOUBLE-quoted attribute and
  // routed through `htmlEscape` (which now covers `'` too) — safe even
  // if the regex source ever grows a quote character.
  const portalPattern = PORTAL_ALLOW_LIST_RE.source.replace(/^\^/, '').replace(/\$$/, '')
  const safePattern = htmlEscape(portalPattern)
  const safeClientId = htmlEscape(clientId)
  const scopeItems = scope.split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => `<li><code>${htmlEscape(s)}</code></li>`)
    .join('')
  // Fork branding (#233): if `NUXT_BITRIX24_OAUTH_APP_DISPLAY_NAME` is
  // set, the heading reflects it ("Connect your Acme Bitrix24"). The
  // fallback "Connect your Bitrix24 portal" matches the v0.2.0 wording.
  const safeDisplayName = opts.displayName.trim() ? htmlEscape(opts.displayName.trim()) : ''
  const heading = safeDisplayName
    ? `Connect your ${safeDisplayName}`
    : 'Connect your Bitrix24 portal'
  const identityLine = safeDisplayName
    ? `This server identifies as <strong>${safeDisplayName}</strong> (Bitrix24 application <code>${safeClientId}</code>).`
    : `This server identifies as Bitrix24 application <code>${safeClientId}</code>.`
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bitrix24 MCP — Connect your portal</title>${renderBrandStylesTag(opts.cspNonce)}</head><body>
<h1>${heading}</h1>
${renderHostnameDisclosure(opts.host)}
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
<p><small>${identityLine} If that's not what your operator told you to expect, stop and check with them before continuing.</small></p>
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
function installErrorPage(errorCode: string, detail: string, retry: boolean, opts: { cspNonce: string | undefined, host: string }): string {
  const safeCode = htmlEscape(errorCode)
  const safeDetail = htmlEscape(detail)
  const retryLink = retry
    ? '<p><a href="/api/oauth/install">&larr; Start over</a></p>'
    : '<p>This needs an operator to fix on the server side — contact them with the error code above.</p>'
  return `<!doctype html><html><head><meta charset="utf-8"><title>OAuth install failed</title>${renderBrandStylesTag(opts.cspNonce)}</head><body>
<h1>OAuth install failed</h1>
${renderHostnameDisclosure(opts.host)}
<p>Error code: <code>${safeCode}</code></p>
<p>${safeDetail}</p>
${retryLink}
</body></html>`
}

export default defineEventHandler(async (event) => {
  const logger = useLogger()
  const wantHtml = wantsHtml(event)
  const {
    bitrix24OauthEnabled,
    bitrix24OauthClientId,
    bitrix24OauthRedirectUrl,
    bitrix24OauthScope,
    bitrix24OauthBrandStyles,
    bitrix24OauthAppDisplayName,
  } = useRuntimeConfig()
  // Brand-styled landing (#233): generate a 128-bit nonce up-front so
  // the SAME value lands in (a) the CSP `style-src 'nonce-X'`
  // directive set on EVERY response path (302 / landing form / HTML
  // deny pages / JSON `throw createError`), and (b) the
  // `<style nonce="X">` tag emitted only on HTML render paths. The
  // strict baseline (`default-src 'none'; frame-ancestors 'none'`) is
  // preserved either way — brand styles are opt-in and external scripts
  // / inline JS / external CSS stay blocked.
  const cspNonce = bitrix24OauthBrandStyles ? generateCspNonce() : undefined
  const host = getRequestURL(event).host
  const displayName = String(bitrix24OauthAppDisplayName ?? '')
  const headerOpts = { formAction: INSTALL_PATH, cspNonce }
  const pageOpts = { cspNonce, host }
  // Pin anti-framing + no-cache on EVERY path: 302 success, the landing
  // form, HTML deny pages, and the JSON `throw createError` throws. h3
  // preserves headers across throws, so the JSON deny responses carry
  // X-Frame-Options + the strict CSP too (uniform contract). The
  // `form-action` directive is pinned to the install path itself —
  // even on JSON deny paths it's harmless (no <form> in JSON bodies)
  // and tightens the uniform CSP without per-branch divergence.
  setAntiFramingHeaders(event, headerOpts)

  // Step 1: flag gate. Even browsers get this — the install link should
  // not be reachable on a webhook-only deploy. The HTML page tells them
  // to ask their operator (not retryable from the user's side).
  if (!bitrix24OauthEnabled) {
    void logger.warning('oauth.install.deny.flag-off', { reason: 'OAuth disabled at runtime' })
    if (wantHtml) {
      setHtmlResponseHeaders(event, headerOpts)
      setResponseStatus(event, 503)
      return installErrorPage(
        'FLAG-OFF',
        'OAuth installation is disabled on this server. The operator needs to enable it before anyone can install.',
        false,
        pageOpts,
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
      setHtmlResponseHeaders(event, headerOpts)
      setResponseStatus(event, 503)
      return installErrorPage(
        'NOT-CONFIGURED',
        'The operator enabled OAuth but did not finish configuring it. Required environment variables are missing on the server.',
        false,
        pageOpts,
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
  // route with `?portal=` absent OR empty, render the landing form
  // instead of refusing with PORTAL-FORMAT. No state minted, no cookie
  // set — pure GET render. CLI callers (no `text/html` in Accept) still
  // drop through to the unchanged 400 path so smoke probes get the
  // byte-identical JSON body+status (anti-framing headers are now
  // present on JSON responses too — see the §3 note in OAUTH-DESIGN.md).
  //
  // We log `ip` here so the §11 monitoring recipe "spike of `landing`
  // events from one IP with no matching `oauth.install.start`" can be
  // built without an nginx access-log join. `clientId` is the
  // marketplace app id (publicly identifiable, not a secret) and is
  // shown on the landing page itself — logging it is intentional.
  if (!portal && wantHtml) {
    void logger.debug('oauth.install.landing', {
      clientId,
      ip: getRequestIP(event) ?? '<unknown>',
    })
    setHtmlResponseHeaders(event, headerOpts)
    return installLandingPage(clientId, scope, { cspNonce, displayName, host })
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
      setHtmlResponseHeaders(event, headerOpts)
      setResponseStatus(event, 400)
      return installErrorPage(
        'PORTAL-FORMAT',
        'The portal hostname you entered is not in the accepted format. It must look like "acme.bitrix24.com" (TLDs allowed: com, ru, eu, de, by, kz, ua).',
        true,
        pageOpts,
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
