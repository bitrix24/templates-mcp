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
 * a deliberate code change.
 */
export const PORTAL_ALLOW_LIST_RE = /^[a-z0-9-]+\.bitrix24\.(?:com|ru|eu|de|by|kz|ua)$/

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
 * Extract the hostname from a Bitrix24-supplied endpoint URL, returning
 * `null` when the URL is malformed, not HTTPS, or the hostname is empty.
 * Centralising the parse keeps the "what counts as a safe URL" rule in
 * one place — every caller above just compares hostnames.
 */
export function safeHostname(rawUrl: unknown): string | null {
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
  return parsed.hostname
}

/**
 * Validate a `client_endpoint` URL from a Bitrix24 token / refresh response.
 *
 * Returns the validated URL on success. On failure — malformed URL, non-HTTPS,
 * or hostname ≠ the stored tenant portal — logs an `oauth.endpoint.reject`
 * warning (event under §11 taxonomy) and returns the safe canonical fallback
 * `https://${portalDomain}/rest/`. Never throws: an endpoint mismatch on a
 * happy-path refresh must not blow up the request, only refuse to trust the
 * upstream-supplied value.
 */
export function validateClientEndpoint(
  rawUrl: unknown,
  portalDomain: string,
  context: { memberId: string, userId: number | string, reason: 'exchange' | 'refresh' },
): string {
  const fallback = `https://${portalDomain}/rest/`
  if (rawUrl == null) return fallback
  const hostname = safeHostname(rawUrl)
  if (hostname === portalDomain) return rawUrl as string
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
 * default. Same no-throw policy as {@link validateClientEndpoint}.
 */
export function validateServerEndpoint(
  rawUrl: unknown,
  context: { memberId: string, userId: number | string, reason: 'refresh' },
): string {
  const fallback = 'https://oauth.bitrix.info/rest/'
  if (rawUrl == null) return fallback
  const hostname = safeHostname(rawUrl)
  if (hostname !== null && CENTRAL_OAUTH_HOSTS.has(hostname)) return rawUrl as string
  void useLogger().warning('oauth.endpoint.reject', {
    field: 'server_endpoint',
    raw: typeof rawUrl === 'string' ? rawUrl.slice(0, 200) : String(rawUrl).slice(0, 200),
    expectedHosts: Array.from(CENTRAL_OAUTH_HOSTS),
    ...context,
  })
  return fallback
}
