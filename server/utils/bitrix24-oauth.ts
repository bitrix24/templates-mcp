import { B24OAuth, type B24OAuthParams, type B24OAuthSecret, type HandlerRefreshAuth } from '@bitrix24/b24jssdk'
import { useLogger } from '~/server/utils/logger'
import { makeRedactingLogger } from '~/server/utils/logger-redactor'
import { isAllowedPortalDomain, validateClientEndpoint, validateServerEndpoint } from '~/server/utils/portal-validation'
import { useTokenStore } from '~/server/utils/token-store'

/**
 * Per-tenant OAuth client factory (`docs/OAUTH-DESIGN.md §5 + §7`).
 *
 * `useBitrix24OAuth(memberId, userId)` returns a memoised `B24OAuth`
 * instance bound to one specific tenant. Used by `useBitrix24Tenant()`
 * when `NUXT_BITRIX24_OAUTH_ENABLED=true` and a tenant context is bound;
 * tools never call this directly.
 *
 * Caching strategy:
 *
 *   - In-memory **LRU** keyed on `${memberId}:${userId}`, capped at 100
 *     entries (the §5 sizing — covers the realistic per-process working
 *     set; a fork serving more tenants per instance can bump the cap).
 *   - **Synchronous** construction. JavaScript's single-threaded event
 *     loop means two callers cannot be mid-init for the same key
 *     simultaneously, so no mutex is needed; the first caller's
 *     `lruSet` settles before the next caller's `lruGet` runs. The
 *     §5 mutex narrative applies only to the REFRESH path inside the
 *     SDK (`setCustomRefreshAuth` is async-callable by the SDK), and
 *     that's handled below.
 *   - **Cache eviction caveat** (§5 known edge case): if an entry is
 *     evicted while a refresh is in flight inside the SDK, a concurrent
 *     call after eviction creates a second instance, both refresh
 *     attempts write the same new tokens (idempotent). We log eviction
 *     so the LRU can be sized correctly.
 *
 * Refresh handling — we use `setCustomRefreshAuth` rather than
 * `setCallbackRefreshAuth` so the HTTP exchange happens on OUR fetch
 * (testable via `vi.stubGlobal('fetch', ...)`), and we have direct
 * control over error classification:
 *
 *   - `invalid_grant` (refresh token revoked / app uninstalled) →
 *     `markRefreshFailed(memberId, userId)` stamps every active Bearer
 *     `revoked_at` so the MCP middleware will start returning 401, then
 *     re-throws. The user re-authorises via `/install`.
 *   - Network error / 5xx → log + re-throw without `markRefreshFailed`.
 *     The next request retries; refresh failure may be transient (DNS,
 *     brief Bitrix24 outage).
 *
 * Logging (§11 taxonomy):
 *   - `oauth.refresh.start`             (INFO — memberId, userId)
 *   - `oauth.refresh.ok`                (INFO — new accessExpiresAt)
 *   - `oauth.refresh.fail.invalid-grant` (ERROR — refresh-token death)
 *   - `oauth.refresh.fail.transient`    (ERROR — network / 5xx)
 *   - `oauth.factory.lru.evicted`       (DEBUG — eviction signal for
 *                                        operator to size the LRU)
 *
 * Last refresh tracker — `lastRefreshOk` / `lastRefreshFail` populated
 * here, read by `/api/oauth/_health` (PR-2c step 4). Process-local; no
 * persistence — the next deploy resets them, which is fine because the
 * audit log carries the durable timeline.
 */

const REFRESH_URL = 'https://oauth.bitrix24.tech/oauth/token/'
const DEFAULT_LRU_MAX = 100

// Mutable so a test can shrink the cap and observe eviction in finite
// time without seeding 101 real tenants. Production never changes it.
let lruMax = DEFAULT_LRU_MAX

const cache = new Map<string, B24OAuth>()

interface RefreshStatus {
  lastRefreshOk: number | null
  lastRefreshFail: number | null
}
const refreshStatus: RefreshStatus = {
  lastRefreshOk: null,
  lastRefreshFail: null,
}

/**
 * @internal — read by `_health.get.ts`. Not part of the public API.
 */
export function _readRefreshStatus(): RefreshStatus {
  return { ...refreshStatus }
}

/**
 * @internal — test reset hook. Production has no use for this. Restores
 * the default LRU cap so a prior test's `_setLruMaxForTests` doesn't
 * bleed into the next.
 */
export function _resetOAuthFactoryForTests(): void {
  cache.clear()
  lruMax = DEFAULT_LRU_MAX
  refreshStatus.lastRefreshOk = null
  refreshStatus.lastRefreshFail = null
}

/**
 * @internal — test-only. Shrinks the LRU cap so eviction is observable
 * without constructing 101 real `B24OAuth` instances.
 */
export function _setLruMaxForTests(n: number): void {
  lruMax = n
}

function lruGet(key: string): B24OAuth | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  // Promote to MRU: delete + re-set preserves insertion order, which
  // is what JS Map iteration is guaranteed to follow.
  cache.delete(key)
  cache.set(key, entry)
  return entry
}

function lruSet(key: string, value: B24OAuth, logger: ReturnType<typeof useLogger>): void {
  // `Map.delete` on an absent key is a harmless no-op, but re-deleting a
  // present key before re-setting moves it to MRU position (insertion
  // order = LRU order).
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > lruMax) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
    void logger.debug('oauth.factory.lru.evicted', { key: oldest, max: lruMax })
  }
}

interface RefreshResponse {
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

export function useBitrix24OAuth(memberId: string, userId: number): B24OAuth {
  const key = `${memberId}:${userId}`

  const cached = lruGet(key)
  if (cached) return cached

  const logger = useLogger()
  const row = useTokenStore().getTokens(memberId, userId)
  if (!row) {
    throw new Error(`oauth_tokens row missing for memberId=${memberId} userId=${userId}`)
  }

  const { bitrix24OauthClientId, bitrix24OauthClientSecret } = useRuntimeConfig()
  const clientId = String(bitrix24OauthClientId ?? '').trim()
  const clientSecret = String(bitrix24OauthClientSecret ?? '').trim()
  if (!clientId || !clientSecret) {
    throw new Error('useBitrix24OAuth requires NUXT_BITRIX24_OAUTH_CLIENT_ID + _CLIENT_SECRET to be set')
  }

  const params: B24OAuthParams = {
    // applicationToken is part of the install-event payload; we don't
    // persist it (the design only stores what's needed for refresh +
    // per-request auth), and B24OAuth doesn't use it on the post-install
    // path. Empty string is the documented placeholder.
    applicationToken: '',
    userId,
    memberId,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expires: row.accessExpiresAt,
    expiresIn: Math.max(0, row.accessExpiresAt - Math.floor(Date.now() / 1000)),
    scope: row.scope,
    domain: row.portalDomain,
    clientEndpoint: `https://${row.portalDomain}/rest/`,
    serverEndpoint: 'https://oauth.bitrix.info/rest/',
    // 'L' = installed for this portal (long-term install). The status
    // field is informational on our side — the SDK uses it for display.
    status: 'L',
  }
  const secret: B24OAuthSecret = { clientId, clientSecret }

  const b24 = new B24OAuth(params, secret)
  // Defence-in-depth (issue #220): wrap the SDK's default logger with the
  // shared redactor so any future regression that logs a URL with a
  // credential, or a refresh-response field containing a token, never
  // reaches stdout in raw form. Mirrors the webhook singleton in
  // `bitrix24.ts:113`. The instances are LRU-cached, so this runs once
  // per tenant and stays attached for the lifetime of the entry.
  //
  // Coverage caveat: `AbstractB24.setLogger` propagates to the actions /
  // tools managers and the HTTP-v2/v3 clients, but NOT to the SDK's
  // internal `AuthOAuthManager` (it has no `setLogger` in
  // @bitrix24/b24jssdk ≤1.1.2 and does not log directly today). If a
  // future SDK major adds logging inside that manager, re-verify this
  // redactor still covers it.
  b24.setLogger(makeRedactingLogger(useLogger()))

  // Custom refresh: we do the fetch + the persistence + the error
  // classification ourselves. The SDK calls this when its internal
  // expiry check trips. The callback is async (the SDK awaits it); the
  // factory itself is sync because B24OAuth construction is sync.
  b24.setCustomRefreshAuth(async (): Promise<HandlerRefreshAuth> => {
    const log = useLogger()
    void log.info('oauth.refresh.start', { memberId, userId })

    const store = useTokenStore()
    const current = store.getTokens(memberId, userId)
    if (!current) {
      // Distinct event (issue #223): a concurrent `deleteTenant()` (operator
      // uninstall) between the SDK's expiry check and this read makes the row
      // vanish. Previously this logged `oauth.refresh.fail.invalid-grant`,
      // indistinguishable from a genuine revoked refresh token — an operator
      // alerting on that event would wrongly think a credential was revoked.
      // It's a benign uninstall race: NO `markRefreshFailed` (nothing to
      // revoke — the CASCADE already dropped the Bearers), its own event.
      //
      // Deliberately does NOT touch `refreshStatus.lastRefreshFail` (#223
      // review): that field feeds `/api/oauth/_health` and is the signal for
      // "credential refresh is failing". A benign uninstall race is NOT a
      // credential failure — bumping it here would re-introduce, at the
      // health-endpoint level, the exact false-alarm this distinct event was
      // created to avoid. The ERROR log + event are the record; health stays
      // clean.
      void log.error('oauth.refresh.fail.tenant-deleted', { memberId, userId })
      throw new Error('oauth_tokens row vanished during refresh')
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: current.refreshToken,
    })

    let res: Response
    try {
      res = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
    }
    catch (err) {
      refreshStatus.lastRefreshFail = Math.floor(Date.now() / 1000)
      void log.error('oauth.refresh.fail.transient', {
        memberId, userId, reason: 'network', message: (err as Error).message,
      })
      throw err
    }

    let data: RefreshResponse
    try {
      data = await res.json() as RefreshResponse
    }
    catch {
      refreshStatus.lastRefreshFail = Math.floor(Date.now() / 1000)
      void log.error('oauth.refresh.fail.transient', {
        memberId, userId, reason: 'non-json', httpStatus: res.status,
      })
      throw new Error(`refresh response was not JSON (HTTP ${res.status})`)
    }

    if (!res.ok || data.error) {
      if (data.error === 'invalid_grant') {
        // Refresh token revoked — operator uninstalled the app, OR a
        // manual revocation happened on Bitrix24's side. Mark every
        // active Bearer for this tenant as revoked so the MCP middleware
        // starts returning 401. The user re-authorises via /install.
        await store.markRefreshFailed(memberId, userId)
        refreshStatus.lastRefreshFail = Math.floor(Date.now() / 1000)
        // Evict the cached instance so a re-authorise lands a fresh
        // one with the new tokens.
        cache.delete(key)
        void log.error('oauth.refresh.fail.invalid-grant', { memberId, userId })
        throw new Error('refresh failed: invalid_grant')
      }
      // 5xx, rate limit, or any other non-invalid_grant error → log as
      // transient and re-throw. No DB writes; the next request retries.
      refreshStatus.lastRefreshFail = Math.floor(Date.now() / 1000)
      void log.error('oauth.refresh.fail.transient', {
        memberId, userId, httpStatus: res.status, error: data.error || `http-${res.status}`,
      })
      throw new Error(`refresh failed: ${data.error || `http-${res.status}`}`)
    }

    // Defence-in-depth (issue #220): the refresh response carries
    // `domain`, `client_endpoint`, and `server_endpoint` from Bitrix24.
    // We never let an upstream-supplied value silently mutate the
    // stored portal or the SDK's HTTP target.
    //
    // - `data.domain`: must pass the allow-list AND equal the stored
    //   portal — a refresh is bound to a specific tenant, swapping
    //   portals mid-flow is a bug or an attack. Refuse without writing.
    // - `data.client_endpoint` / `data.server_endpoint`: validated by the
    //   shared helpers below, which substitute the safe canonical URL
    //   and log `oauth.endpoint.reject` on mismatch (no throw).
    if (data.domain != null && (!isAllowedPortalDomain(data.domain) || data.domain !== current.portalDomain)) {
      refreshStatus.lastRefreshFail = Math.floor(Date.now() / 1000)
      void log.error('oauth.refresh.fail.transient', {
        memberId,
        userId,
        reason: 'domain-mismatch',
        expected: current.portalDomain,
        got: typeof data.domain === 'string' ? data.domain.slice(0, 253) : String(data.domain).slice(0, 253),
      })
      throw new Error('refresh failed: domain-mismatch')
    }
    const validatedClientEndpoint = validateClientEndpoint(
      data.client_endpoint,
      current.portalDomain,
      { memberId, userId, reason: 'refresh' },
    )
    const validatedServerEndpoint = validateServerEndpoint(
      data.server_endpoint,
      { memberId, userId, reason: 'refresh' },
    )

    // Happy path — persist new tokens (audit-first via upsertTokens).
    const accessExpiresAt = data.expires ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600)
    await store.upsertTokens({
      memberId,
      userId,
      portalDomain: data.domain ?? current.portalDomain,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      accessExpiresAt,
      scope: data.scope ?? current.scope,
    }, 'refresh')

    refreshStatus.lastRefreshOk = Math.floor(Date.now() / 1000)
    void log.info('oauth.refresh.ok', { memberId, userId, accessExpiresAt })

    // SDK's HandlerAuthParams types `expires` and `expires_in` as
    // strings (not numbers — see @bitrix24/b24jssdk@1.1.2 d.ts);
    // coerce on the boundary so the type contract holds.
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires: String(accessExpiresAt),
      expires_in: String(data.expires_in ?? 3600),
      client_endpoint: validatedClientEndpoint,
      server_endpoint: validatedServerEndpoint,
      member_id: data.member_id ?? memberId,
      scope: data.scope ?? current.scope,
      status: data.status ?? 'L',
      domain: data.domain ?? current.portalDomain,
    }
  })

  lruSet(key, b24, logger)
  return b24
}
