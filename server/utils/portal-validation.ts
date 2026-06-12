import { useLogger } from '~/server/utils/logger'

/**
 * Bitrix24 portal hostname allow-list (issue #220).
 *
 * Defence-in-depth on every code path that accepts a "portal" string from
 * outside this server: the install query parameter (operator-supplied), the
 * token-exchange response `domain` field (Bitrix24-side, but if
 * `oauth.bitrix24.tech` is ever compromised — DNS/BGP poisoning, upstream
 * bug — the value lands in our DB and becomes the `clientEndpoint` host for
 * every subsequent REST call). One regex, one place: every Bitrix24-facing
 * surface validates through this module.
 *
 * The pattern matches the cloud TLDs we publicly support; self-hosted
 * portals do not flow through `/install` (they use webhook auth) and so
 * are intentionally out of scope here. Extending the allow-list requires
 * a deliberate code change. Each label is constrained to RFC-1123 shape
 * (no leading/trailing hyphen) so `-acme.bitrix24.com` / `acme-.bitrix24.com`
 * are rejected.
 */
export const PORTAL_ALLOW_LIST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bitrix24\.(?:com|ru|eu|de|by|kz|ua)$/

/**
 * `true` when `value` is a non-empty string matching `PORTAL_ALLOW_LIST_RE`.
 *
 * Use for every Bitrix24-returned `domain` field (token exchange, refresh).
 * Always combine with a *cross-check* against the prior-validated portal
 * (i.e. the value the operator passed at `/install`, or the stored
 * `portalDomain` on refresh) to defeat the case where the Bitrix24 endpoint
 * returns a different — but still allow-listed — portal for a flow that was
 * bound to a specific tenant.
 */
export function isAllowedPortalDomain(value: unknown): value is string {
  return typeof value === 'string' && PORTAL_ALLOW_LIST_RE.test(value)
}

/**
 * Known central Bitrix24 OAuth hosts (NOT a tenant portal). The
 * `server_endpoint` field of a refresh response legitimately points at
 * `oauth.bitrix.info` (or `oauth.bitrix24.tech`) for token operations;
 * `client_endpoint` points at the tenant portal. Validate `client_endpoint`
 * against `PORTAL_ALLOW_LIST_RE` + the stored `portalDomain`; validate
 * `server_endpoint` against this set.
 */
const CENTRAL_OAUTH_HOSTS = new Set(['oauth.bitrix.info', 'oauth.bitrix24.tech'])

export function isAllowedCentralOauthHost(value: unknown): value is string {
  return typeof value === 'string' && CENTRAL_OAUTH_HOSTS.has(value)
}

/**
 * Parse a Bitrix24-supplied endpoint URL, returning the parsed `URL` only
 * when it is a *clean* HTTPS URL: HTTPS scheme, a non-empty hostname, NO
 * embedded userinfo (`user:pass@`), and NO explicit port. Anything else
 * returns `null`.
 *
 * The userinfo / port guards matter: `URL.hostname` silently strips both,
 * so a naive `hostname === portalDomain` check would pass for
 * `https://attacker:creds@acme.bitrix24.com:9000/rest/` while the raw string
 * (with credentials and an attacker-chosen port) flowed on to the SDK. We
 * reject those shapes outright — a cloud Bitrix24 portal never uses them.
 */
function parseCleanHttpsUrl(rawUrl: unknown): URL | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return null
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  }
  catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  if (parsed.username !== '' || parsed.password !== '') return null
  if (parsed.port !== '') return null
  return parsed
}

/**
 * Extract the hostname from a clean Bitrix24-supplied HTTPS endpoint URL,
 * returning `null` when the URL is malformed, not HTTPS, carries userinfo,
 * or specifies a port. Centralising the parse keeps the "what counts as a
 * safe URL" rule in one place — every caller compares hostnames.
 */
export function safeHostname(rawUrl: unknown): string | null {
  return parseCleanHttpsUrl(rawUrl)?.hostname ?? null
}

/**
 * Re-serialise a parsed URL to its scheme+host+path form, dropping any
 * query string or fragment. By the time this runs the URL has already
 * passed {@link parseCleanHttpsUrl} (no userinfo, no port), so the result
 * is a canonical `https://<host><path>` with nothing attacker-controllable
 * smuggled past the hostname check.
 */
function canonicalUrl(parsed: URL): string {
  return `${parsed.origin}${parsed.pathname}`
}

/**
 * Validate a `client_endpoint` URL from a Bitrix24 token / refresh response.
 *
 * Returns a **canonicalised** copy of the URL on success (scheme+host+path,
 * query/fragment stripped). On failure — malformed, non-HTTPS, userinfo,
 * a port, or hostname ≠ the stored tenant portal — logs an
 * `oauth.endpoint.reject` warning (§11 taxonomy) and returns the safe
 * canonical fallback `https://${portalDomain}/rest/`. Never throws: an
 * endpoint mismatch on a happy-path refresh must not blow up the request,
 * only refuse to trust the upstream-supplied value.
 *
 * Operators should configure an alert on `oauth.endpoint.reject` — silent
 * substitution is correct for liveness, but a repeated occurrence signals
 * an upstream anomaly (or a compromise of the Bitrix24 OAuth endpoint)
 * worth investigating.
 */
export function validateClientEndpoint(
  rawUrl: unknown,
  portalDomain: string,
  context: { memberId: string, userId: number | string, reason: 'refresh' },
): string {
  const fallback = `https://${portalDomain}/rest/`
  if (rawUrl == null) return fallback
  const parsed = parseCleanHttpsUrl(rawUrl)
  if (parsed !== null && parsed.hostname === portalDomain) return canonicalUrl(parsed)
  void useLogger().warning('oauth.endpoint.reject', {
    field: 'client_endpoint',
    raw: typeof rawUrl === 'string' ? rawUrl.slice(0, 200) : String(rawUrl).slice(0, 200),
    expectedHost: portalDomain,
    ...context,
  })
  return fallback
}

/**
 * Validate a `server_endpoint` URL from a Bitrix24 refresh response.
 *
 * `server_endpoint` legitimately points at the central Bitrix24 OAuth host
 * (`oauth.bitrix.info` is the historical default, `oauth.bitrix24.tech` the
 * newer one). Anything else is rejected and replaced with the documented
 * default. Returns a canonicalised copy on success. Same no-throw +
 * `oauth.endpoint.reject` policy as {@link validateClientEndpoint}.
 */
export function validateServerEndpoint(
  rawUrl: unknown,
  context: { memberId: string, userId: number | string, reason: 'refresh' },
): string {
  const fallback = 'https://oauth.bitrix.info/rest/'
  if (rawUrl == null) return fallback
  const parsed = parseCleanHttpsUrl(rawUrl)
  if (parsed !== null && isAllowedCentralOauthHost(parsed.hostname)) return canonicalUrl(parsed)
  void useLogger().warning('oauth.endpoint.reject', {
    field: 'server_endpoint',
    raw: typeof rawUrl === 'string' ? rawUrl.slice(0, 200) : String(rawUrl).slice(0, 200),
    expectedHosts: Array.from(CENTRAL_OAUTH_HOSTS),
    ...context,
  })
  return fallback
}
