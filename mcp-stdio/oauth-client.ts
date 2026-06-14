import { B24OAuth, type B24OAuthParams, type B24OAuthSecret, type HandlerRefreshAuth } from '@bitrix24/b24jssdk'
import { useLogger } from '~/server/utils/logger'
import { makeRedactingLogger } from '~/server/utils/logger-redactor'
import { validateClientEndpoint, validateServerEndpoint } from '~/server/utils/portal-validation'
import { recordDxtAuditEvent } from './audit-log'
import type { OAuthStore, OAuthTokens } from './oauth-store'

const TOKEN_URL = 'https://oauth.bitrix24.tech/oauth/token/'

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  expires?: number
  scope?: string
  domain?: string
  client_endpoint?: string
  server_endpoint?: string
  status?: string
  member_id?: string
  user_id?: number | string
  error?: string
  error_description?: string
}

/**
 * Exchange the OOB `code` (30s TTL) for an initial token pair, persist
 * them, and seed audit. Throws on any failure — caller (the paste-code
 * tool) maps the error to a user-friendly message.
 *
 * Mirrors the HTTP callback flow in `server/api/oauth/callback.get.ts`
 * but without `redirect_uri` (Bitrix24's OOB protocol explicitly omits
 * it for installations that have no fixed callback URL — see issue body
 * for the spec reference).
 */
export async function exchangeOobCode(args: {
  code: string
  clientId: string
  clientSecret: string
  store: OAuthStore
  dataDirOverride?: string
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
  })

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })

  let data: TokenResponse
  try { data = await res.json() as TokenResponse }
  catch { throw new Error(`oauth token endpoint returned non-JSON (HTTP ${res.status})`) }

  if (!res.ok || data.error) {
    const reason = data.error_description ?? data.error ?? `http-${res.status}`
    recordDxtAuditEvent({ event: 'oauth.fail.transient', detail: reason }, args.dataDirOverride)
    throw new Error(`oauth code exchange failed: ${reason}`)
  }

  if (!data.access_token || !data.refresh_token || !data.domain || data.user_id == null || !data.member_id) {
    throw new Error('oauth code exchange succeeded but the response is missing required fields')
  }

  const row: OAuthTokens = {
    memberId: data.member_id,
    userId: typeof data.user_id === 'string' ? Number(data.user_id) : data.user_id,
    portalDomain: data.domain,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accessExpiresAt: data.expires ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    scope: data.scope ?? '',
    refreshInvalid: false,
  }
  args.store.write(row)
  recordDxtAuditEvent(
    { event: 'oauth.upsert.exchange', memberId: row.memberId, userId: row.userId },
    args.dataDirOverride,
  )
  return row
}

/**
 * Build a `B24OAuth` instance from the on-disk token row, wired with a
 * custom refresh handler that writes new tokens back to the store. Throws
 * if the store is empty or marked invalid — caller should fall through
 * to the onboarding path.
 *
 * Port of the HTTP factory in `server/utils/bitrix24-oauth.ts`. Not 100%
 * identical: there is no LRU (single tenant), no tenant-deleted race
 * (single process, single store), and refresh persistence writes to
 * `OAuthStore` instead of SQLite.
 */
export function buildOAuthClient(args: {
  clientId: string
  clientSecret: string
  store: OAuthStore
  dataDirOverride?: string
}): B24OAuth {
  const row = args.store.read()
  if (!row) throw new Error('no OAuth tokens on disk — onboarding required')
  if (row.refreshInvalid) throw new Error('OAuth refresh token has been revoked — re-onboarding required')

  const params: B24OAuthParams = {
    applicationToken: '',
    userId: row.userId,
    memberId: row.memberId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expires: row.accessExpiresAt,
    expiresIn: Math.max(0, row.accessExpiresAt - Math.floor(Date.now() / 1000)),
    scope: row.scope,
    domain: row.portalDomain,
    clientEndpoint: `https://${row.portalDomain}/rest/`,
    serverEndpoint: 'https://oauth.bitrix.info/rest/',
    status: 'L',
  }
  const secret: B24OAuthSecret = { clientId: args.clientId, clientSecret: args.clientSecret }
  const b24 = new B24OAuth(params, secret)
  b24.setLogger(makeRedactingLogger(useLogger()))

  b24.setCustomRefreshAuth(async (): Promise<HandlerRefreshAuth> => {
    const log = useLogger()
    const current = args.store.read()
    if (!current) {
      // Follow-up R3 (#239 /review): mirror the HTTP factory's
      // `tenant-deleted` audit event. Single-tenant DXT can hit this
      // when the user deletes `oauth.json` mid-flight (or another
      // process truncates the file). Emit so the operator's `audit.log`
      // shows the "tokens gone" timeline before the throw surfaces in
      // their MCP client.
      recordDxtAuditEvent(
        { event: 'oauth.fail.transient', detail: 'tenant-deleted' },
        args.dataDirOverride,
      )
      throw new Error('OAuth tokens vanished mid-refresh')
    }

    // Follow-up R2 (#239 /review): parity with HTTP factory's
    // `oauth.refresh.start` info log (`server/utils/bitrix24-oauth.ts:208`).
    // Operators correlating `.start` ↔ `.ok` / `.fail` in `audit.log`
    // expect the same taxonomy on both transports.
    void log.info('oauth.refresh.start', { memberId: current.memberId, userId: current.userId })

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: current.refreshToken,
    })

    let res: Response
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
    }
    catch (err) {
      recordDxtAuditEvent(
        { event: 'oauth.fail.transient', memberId: current.memberId, userId: current.userId, detail: `network:${(err as Error).message}` },
        args.dataDirOverride,
      )
      throw err
    }

    let data: TokenResponse
    try { data = await res.json() as TokenResponse }
    catch {
      recordDxtAuditEvent(
        { event: 'oauth.fail.transient', memberId: current.memberId, userId: current.userId, detail: `non-json-http-${res.status}` },
        args.dataDirOverride,
      )
      throw new Error(`refresh response was not JSON (HTTP ${res.status})`)
    }

    if (!res.ok || data.error) {
      if (data.error === 'invalid_grant') {
        // Pass the refresh_token we USED for the failing request — the
        // store compares before stamping invalid, so a concurrent
        // successful re-onboarding that rotated the token between
        // start-of-refresh and now isn't punished (follow-up S2).
        args.store.markRefreshFailed(current.refreshToken)
        recordDxtAuditEvent(
          { event: 'oauth.fail.invalid-grant', memberId: current.memberId, userId: current.userId },
          args.dataDirOverride,
        )
        void log.error('oauth.refresh.fail.invalid-grant', { memberId: current.memberId, userId: current.userId })
        throw new Error('refresh failed: invalid_grant — re-onboarding required')
      }
      recordDxtAuditEvent(
        { event: 'oauth.fail.transient', memberId: current.memberId, userId: current.userId, detail: data.error ?? `http-${res.status}` },
        args.dataDirOverride,
      )
      throw new Error(`refresh failed: ${data.error ?? `http-${res.status}`}`)
    }

    // Defence-in-depth (parity with HTTP factory in
    // `server/utils/bitrix24-oauth.ts:290-320`): we never let an
    // upstream-supplied value silently mutate the stored portal or the
    // SDK's HTTP target.
    //
    // - `data.domain` cross-check: a refresh is bound to the tenant the
    //   user originally authorised against; swapping mid-flow is a bug
    //   or attack. Refuse without writing. NOTE: we intentionally do
    //   NOT gate this through `isAllowedPortalDomain` (cloud-only allow-
    //   list) because Self-Hosted DXT installs are explicitly supported
    //   here — the stored portal IS the trust anchor.
    // - `data.client_endpoint` / `data.server_endpoint`: validated via
    //   the shared helpers, which substitute the safe canonical URL and
    //   log `oauth.endpoint.reject` on mismatch (no throw). The SDK
    //   uses `client_endpoint` for REST routing; an upstream-injected
    //   `https://evil.com/rest/` would otherwise route every subsequent
    //   call through evil.com.
    if (data.domain != null && data.domain !== current.portalDomain) {
      recordDxtAuditEvent(
        {
          event: 'oauth.fail.transient',
          memberId: current.memberId,
          userId: current.userId,
          detail: `domain-mismatch:${String(data.domain).slice(0, 253)}`,
        },
        args.dataDirOverride,
      )
      throw new Error('refresh failed: domain-mismatch')
    }
    const validatedClientEndpoint = validateClientEndpoint(
      data.client_endpoint,
      current.portalDomain,
      { memberId: current.memberId, userId: current.userId, reason: 'refresh' },
    )
    const validatedServerEndpoint = validateServerEndpoint(
      data.server_endpoint,
      { memberId: current.memberId, userId: current.userId, reason: 'refresh' },
    )

    const accessExpiresAt = data.expires ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600)
    const next: OAuthTokens = {
      ...current,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      accessExpiresAt,
      scope: data.scope ?? current.scope,
      refreshInvalid: false,
    }
    args.store.write(next)
    recordDxtAuditEvent(
      { event: 'oauth.upsert.refresh', memberId: next.memberId, userId: next.userId },
      args.dataDirOverride,
    )
    void log.info('oauth.refresh.ok', { memberId: next.memberId, userId: next.userId, accessExpiresAt })

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires: String(accessExpiresAt),
      expires_in: String(data.expires_in ?? 3600),
      client_endpoint: validatedClientEndpoint,
      server_endpoint: validatedServerEndpoint,
      member_id: data.member_id ?? next.memberId,
      scope: data.scope ?? next.scope,
      status: data.status ?? 'L',
      domain: data.domain ?? next.portalDomain,
    }
  })

  return b24
}

/**
 * Build the OOB consent URL the user opens in their browser. No
 * `redirect_uri` — Bitrix24's consent page displays the code inline for
 * the user to copy. `state` is included for hygiene (browser history,
 * log correlation) but plays no security role here: there's no callback
 * for it to be validated against.
 */
export function buildOnboardingUrl(args: {
  portalHost: string
  clientId: string
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    state: `dxt-${Math.random().toString(36).slice(2, 10)}`,
  })
  return `https://${args.portalHost}/oauth/authorize/?${params.toString()}`
}
