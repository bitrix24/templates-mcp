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
export function setAntiFramingHeaders(event: H3Event, opts: { formAction?: string } = {}): void {
  setResponseHeader(event, 'cache-control', 'no-store, no-cache')
  setResponseHeader(event, 'pragma', 'no-cache')
  setResponseHeader(event, 'x-frame-options', 'DENY')
  const csp = opts.formAction
    ? `default-src 'none'; frame-ancestors 'none'; form-action ${opts.formAction}`
    : 'default-src \'none\'; frame-ancestors \'none\''
  setResponseHeader(event, 'content-security-policy', csp)
}

/**
 * HTML render paths additionally pin `content-type: text/html`.
 * Always preceded by (and additive to) `setAntiFramingHeaders` — call
 * this helper only on paths that return HTML body, not on `throw
 * createError` paths (h3 picks the content-type for those).
 */
export function setHtmlResponseHeaders(event: H3Event, opts: { formAction?: string } = {}): void {
  setAntiFramingHeaders(event, opts)
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
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
