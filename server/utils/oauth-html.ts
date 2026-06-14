import { randomBytes } from 'node:crypto'
import { setResponseHeader } from 'h3'
import type { H3Event } from 'h3'

/**
 * Anti-framing + anti-cache + strict-CSP response headers, shared by
 * the two HTML-rendering OAuth routes (`/api/oauth/install` and
 * `/api/oauth/callback`).
 *
 * History: this lived as a per-file copy in both handlers from the
 * #221 hardening through the #232 operator-UX PR. The CSP started
 * drifting (install added `form-action 'self'` for the landing form,
 * callback didn't need it) so we lifted it here — one home for the
 * posture, per-route opt-in for any extras.
 *
 * What's pinned (called by both routes, on EVERY response path —
 * success page, HTML error pages, AND the JSON `throw createError`
 * deny branches; h3 preserves these across throws so the contract is
 * uniform):
 *
 * - `Cache-Control: no-store, no-cache` + `Pragma: no-cache` —
 *   callback's success page carries the raw Bearer; install's deny
 *   pages can carry attacker-controlled `?portal=` echoes. Neither
 *   may land in a proxy/CDN cache. `Pragma` covers HTTP/1.0 proxies
 *   (uncommon but cheap).
 * - `X-Frame-Options: DENY` + `frame-ancestors 'none'` — defends
 *   against a same-site frame reading the displayed Bearer or
 *   phishing-overlaying the install form. `SameSite=Lax` on the CSRF
 *   cookie does NOT cover same-site framing.
 * - `default-src 'none'` — the pages are fully self-contained: no
 *   JS, no external assets, no inline styles. Maximally strict CSP
 *   with no `'unsafe-inline'` carve-out.
 *
 * The optional `formAction` lets a caller opt into a specific
 * `form-action` directive — install passes `/api/oauth/install` so
 * the landing form's GET submission is allowed without granting
 * `'self'`-wide form-action (no other endpoint on the same origin
 * can be the target of a form post under the resulting policy).
 * Callback omits it (no `<form>` on the success or error pages).
 */
export interface AntiFramingOpts {
  /**
   * Restrict the page's `<form>` submission target. Install passes
   * `/api/oauth/install` so the landing form's GET round-trip is
   * allowed without granting `'self'`-wide form-action. Callback omits
   * it (no `<form>` on the success or error pages).
   */
  formAction?: string
  /**
   * When provided, add `style-src 'nonce-<value>'` to the CSP so the
   * page can ship one `<style nonce="<value>">…</style>` block under
   * the same nonce. Strict baseline (`default-src 'none'`) stays —
   * external CSS, inline scripts, etc. remain blocked. Opt-in per
   * issue #233; falsy / absent → unchanged strict-CSP shape.
   *
   * Callers MUST pass the SAME nonce to the HTML render (`<style
   * nonce="…">`); a mismatch silently makes the styles ineffective.
   * Generate via {@link generateCspNonce}.
   */
  cspNonce?: string
}

export function setAntiFramingHeaders(event: H3Event, opts: AntiFramingOpts = {}): void {
  setResponseHeader(event, 'cache-control', 'no-store, no-cache')
  setResponseHeader(event, 'pragma', 'no-cache')
  setResponseHeader(event, 'x-frame-options', 'DENY')
  // Build CSP directives positionally so order stays stable for snapshot
  // tests (browsers don't care about order, but a stable string is
  // easier to assert on).
  const directives = ['default-src \'none\'', 'frame-ancestors \'none\'']
  if (opts.cspNonce) directives.push(`style-src 'nonce-${opts.cspNonce}'`)
  if (opts.formAction) directives.push(`form-action ${opts.formAction}`)
  setResponseHeader(event, 'content-security-policy', directives.join('; '))
}

/**
 * HTML render paths additionally pin `content-type: text/html`.
 * Always preceded by (and additive to) `setAntiFramingHeaders` — call
 * this helper only on paths that return HTML body, not on `throw
 * createError` paths (h3 picks the content-type for those).
 */
export function setHtmlResponseHeaders(event: H3Event, opts: AntiFramingOpts = {}): void {
  setAntiFramingHeaders(event, opts)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
}

/**
 * 128-bit (16-byte) random nonce, base64-encoded. The CSP3 spec only
 * needs a per-response value with enough entropy that an attacker can't
 * guess it; 128 bits is well above the required floor and matches
 * common practice (Rails / Django, ~16-24 bytes).
 */
export function generateCspNonce(): string {
  return randomBytes(16).toString('base64')
}

/**
 * Minimal stylesheet for the install + callback landing pages. System
 * font stack so we don't pull in a web font (would need `font-src`
 * carve-out), modest spacing, Bitrix24 brand accent (`#2fc6f6` from
 * the b24jssdk badge). Intentionally small (<1 KB) so the page renders
 * fast even on the cold MCP host's first hit.
 */
const BRAND_STYLES = `body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#111}h1{color:#2fc6f6;font-weight:600;margin-bottom:.5rem;font-size:1.6rem}h2{font-size:1.1rem;margin-top:2rem}small{color:#555}input[type=text]{padding:.5rem;border:1px solid #ccc;border-radius:4px;width:100%;box-sizing:border-box;font-size:1rem}button{background:#2fc6f6;color:#fff;border:0;border-radius:4px;padding:.6rem 1.2rem;font-size:1rem;margin-top:1rem;cursor:pointer}button:hover{background:#20a8d6}code{background:#f4f4f4;padding:.1rem .3rem;border-radius:3px;font-size:.9rem}ul,ol{padding-left:1.5rem}a{color:#2fc6f6}`

/**
 * Returns a `<style nonce="…">…</style>` block for the brand styles, or
 * empty string when no nonce was provided (i.e. the operator hasn't
 * opted into branded styling — strict-CSP baseline preserved).
 *
 * The nonce attribute value is NOT HTML-escaped here because
 * `generateCspNonce` returns base64 from `crypto.randomBytes` which
 * cannot contain `<` / `>` / `&` / `"` / `'`. A caller passing a
 * user-controlled string would be misusing the API; the function's
 * contract is "nonce only".
 */
export function renderBrandStylesTag(cspNonce: string | undefined): string {
  if (!cspNonce) return ''
  return `<style nonce="${cspNonce}">${BRAND_STYLES}</style>`
}

/**
 * Renders an anti-phishing hostname-disclosure block — "You are
 * connecting to: <code>mcp.example.com</code>". Always emitted (does
 * not depend on the brand-styles flag) because the security need is
 * orthogonal to branding: an operator running strict-CSP unstyled
 * still benefits from a visible hostname affirmation.
 *
 * Derive the host server-side from `getRequestURL(event).host`; never
 * trust a client-supplied value. The host is escaped through
 * {@link htmlEscape} defensively even though h3 derives it from the
 * request's Host header which the reverse proxy / app-router should
 * have already normalized.
 */
export function renderHostnameDisclosure(host: string): string {
  return `<p><small>You are connecting to: <code>${htmlEscape(host)}</code>. If this hostname isn't what your operator told you to expect, stop and verify before continuing.</small></p>`
}

/**
 * Escape the five characters that change parser state in HTML element
 * content AND attribute values: `& < > " '`.
 *
 * The `'` mapping is structural completeness (#232 security review):
 * if a caller ever interpolates into a single-quoted attribute, or a
 * future input source contains `'`, the helper handles it without a
 * second pass. The `?? c` fallback is a no-op preserve so TypeScript
 * doesn't need a non-null assertion that would lie about a drift
 * between the regex class and the lookup table.
 */
export function htmlEscape(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  }[c] ?? c))
}
