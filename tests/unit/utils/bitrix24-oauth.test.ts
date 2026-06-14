/**
 * Unit suite for `useBitrix24OAuth(memberId, userId)` (PR-2c step 7).
 *
 * What this suite proves:
 *   - LRU + mutex: concurrent calls for the same key share ONE init.
 *   - Cache hit returns the same instance (identity equality).
 *   - Missing oauth_tokens row → throw.
 *   - Missing CLIENT_ID/CLIENT_SECRET → throw.
 *   - LRU eviction at capacity (LRU-of-100 — we use a tighter cap via a
 *     reset hook so the eviction is observable in finite test time).
 *   - Refresh happy path: HTTP POST shape correct, new tokens
 *     persisted via `upsertTokens('refresh')`, `lastRefreshOk` updated.
 *   - Refresh `invalid_grant`: `markRefreshFailed` fires, instance is
 *     evicted from cache, `lastRefreshFail` updated.
 *   - Refresh transient (5xx, network) → re-throws without
 *     `markRefreshFailed`, `lastRefreshFail` updated.
 *   - The raw refresh_token NEVER appears in any logged context.
 */
import type { CustomRefreshAuth } from '@bitrix24/b24jssdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type * as AuditLogModule from '~/server/utils/audit-log'
import type * as TokenStoreModule from '~/server/utils/token-store'
import type * as OAuthFactoryModule from '~/server/utils/bitrix24-oauth'
import { createTokenStore, type TokenStore } from '~/server/utils/token-store'

// Mock the audit log — `store.upsertTokens` / `createMcpToken` /
// `revokeMcpToken` all audit (PR-2b invariant). The real audit-log
// tries to `mkdir /data/audit` on first write, which fails with EACCES
// on CI runners. Same `vi.hoisted` pattern as `token-store.test.ts`.
type AuditEvent = Parameters<typeof AuditLogModule.recordAuditEvent>[0]
const { recordAuditEvent } = vi.hoisted(() => ({
  recordAuditEvent: vi.fn<(event: AuditEvent) => Promise<void>>(async () => undefined),
}))
vi.mock('~/server/utils/audit-log', async () => {
  const real = await vi.importActual<typeof AuditLogModule>('~/server/utils/audit-log')
  return { ...real, recordAuditEvent }
})

const runtimeConfig: Record<string, unknown> = {
  bitrix24OauthEnabled: true,
  bitrix24OauthClientId: 'app.cid.12345',
  bitrix24OauthClientSecret: 'super-secret',
}
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

const loggerCalls: Array<{ level: string; event: string; ctx: Record<string, unknown> | undefined }> = []
const log = (level: string) => (event: string, ctx?: Record<string, unknown>): Promise<void> => {
  loggerCalls.push({ level, event, ctx })
  return Promise.resolve()
}
vi.mock('~/server/utils/logger', () => ({
  useLogger: () => ({
    info: log('info'),
    warning: log('warning'),
    error: log('error'),
    debug: log('debug'),
    notice: log('notice'),
  }),
}))

let db: Database.Database
let store: TokenStore
vi.mock('~/server/utils/token-store', async () => {
  const real = await vi.importActual<typeof TokenStoreModule>('~/server/utils/token-store')
  return { ...real, useTokenStore: () => store }
})

const fetchMock = vi.fn<(typeof globalThis.fetch)>()
vi.stubGlobal('fetch', fetchMock)

const SAMPLE_TENANT = {
  memberId: 'portal-acme',
  userId: 42,
  portalDomain: 'acme.bitrix24.com',
  accessToken: 'access-token-v1',
  refreshToken: 'refresh-token-v1',
  accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  scope: 'user,task',
}

beforeEach(async () => {
  db = new Database(':memory:')
  store = createTokenStore(db)
  loggerCalls.length = 0
  fetchMock.mockReset()
  // Reset runtimeConfig so a previous-test mutation that crashed
  // before its restore line doesn't leak into the next test.
  runtimeConfig.bitrix24OauthEnabled = true
  runtimeConfig.bitrix24OauthClientId = 'app.cid.12345'
  runtimeConfig.bitrix24OauthClientSecret = 'super-secret'
  vi.resetModules()
  const mod = await import('~/server/utils/bitrix24-oauth')
  mod._resetOAuthFactoryForTests()
})
afterEach(() => {
  db.close()
})

async function loadFactory(): Promise<typeof OAuthFactoryModule> {
  return await import('~/server/utils/bitrix24-oauth')
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('useBitrix24OAuth — caching + mutex', () => {
  beforeEach(async () => {
    await store.upsertTokens(SAMPLE_TENANT, 'install')
    loggerCalls.length = 0
  })

  it('returns a B24OAuth instance for an existing tenant', async () => {
    const { useBitrix24OAuth } = await loadFactory()
    const b24 = await useBitrix24OAuth('portal-acme', 42)
    expect(b24).toBeDefined()
    expect(typeof b24.setCustomRefreshAuth).toBe('function')
  })

  it('caches: two sequential calls return the SAME instance (identity)', async () => {
    const { useBitrix24OAuth } = await loadFactory()
    const first = await useBitrix24OAuth('portal-acme', 42)
    const second = await useBitrix24OAuth('portal-acme', 42)
    expect(first).toBe(second)
  })

  it('N concurrent calls for the same key all share ONE instance (sync construction = no race)', async () => {
    // The factory is synchronous, so N calls in the same tick all hit
    // the cache after the first one populates it. Even if the calls
    // were truly parallel (worker_threads), JS's single-threaded event
    // loop serialises them — a second init can't start until the first
    // returns. Either way: all callers share one instance.
    const { useBitrix24OAuth } = await loadFactory()
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => useBitrix24OAuth('portal-acme', 42)),
    )
    const first = results[0]!
    for (const r of results) expect(r).toBe(first)
  })

  it('different tenants get different instances', async () => {
    await store.upsertTokens({ ...SAMPLE_TENANT, memberId: 'portal-b' }, 'install')
    const { useBitrix24OAuth } = await loadFactory()
    const a = await useBitrix24OAuth('portal-acme', 42)
    const b = await useBitrix24OAuth('portal-b', 42)
    expect(a).not.toBe(b)
  })

  it('throws when the tenant row is missing', async () => {
    const { useBitrix24OAuth } = await loadFactory()
    expect(() => useBitrix24OAuth('nope', 999)).toThrow(/oauth_tokens row missing/)
  })

  it('throws when CLIENT_ID is empty', async () => {
    runtimeConfig.bitrix24OauthClientId = ''
    const { useBitrix24OAuth } = await loadFactory()
    expect(() => useBitrix24OAuth('portal-acme', 42)).toThrow(/CLIENT_ID/)
  })

  it('evicts the oldest entry when the cache exceeds the LRU cap + logs oauth.factory.lru.evicted', async () => {
    // Shrink the cap to 2 so eviction is observable without 101 tenants.
    const mod = await loadFactory()
    mod._setLruMaxForTests(2)
    // Seed 3 distinct tenants.
    for (const id of ['t1', 't2', 't3']) {
      await store.upsertTokens({ ...SAMPLE_TENANT, memberId: id }, 'install')
    }
    loggerCalls.length = 0
    const a = mod.useBitrix24OAuth('t1', 42) // cache: [t1]
    mod.useBitrix24OAuth('t2', 42) //            cache: [t1, t2]
    mod.useBitrix24OAuth('t3', 42) //            cache: [t2, t3]  — t1 evicted
    // t1 was the oldest → evicted → a fresh instance on next call.
    const aAgain = mod.useBitrix24OAuth('t1', 42)
    expect(aAgain).not.toBe(a)
    const evicted = loggerCalls.find(c => c.event === 'oauth.factory.lru.evicted')
    expect(evicted).toBeDefined()
    expect(evicted!.ctx).toMatchObject({ key: 't1:42', max: 2 })
  })

  it('promotes a cache hit to MRU so it survives the next eviction (true LRU order)', async () => {
    const mod = await loadFactory()
    mod._setLruMaxForTests(2)
    for (const id of ['t1', 't2', 't3']) {
      await store.upsertTokens({ ...SAMPLE_TENANT, memberId: id }, 'install')
    }
    const a = mod.useBitrix24OAuth('t1', 42) // [t1]
    mod.useBitrix24OAuth('t2', 42) //           [t1, t2]
    mod.useBitrix24OAuth('t1', 42) //           [t2, t1]  — t1 promoted to MRU
    mod.useBitrix24OAuth('t3', 42) //           [t1, t3]  — t2 evicted (now oldest)
    // t1 survived (promoted), so it's the SAME instance.
    expect(mod.useBitrix24OAuth('t1', 42)).toBe(a)
  })
})

describe('useBitrix24OAuth — refresh flow', () => {
  // We exercise refresh behaviour by spying on `B24OAuth.prototype.setCustomRefreshAuth`
  // to capture the callback the factory installs, then invoking it
  // directly. The captured function IS the factory's refresh logic
  // (HTTP fetch + persistence + classification); calling it directly
  // is the unit-test equivalent of "the SDK detected expiry and called
  // refresh", without round-tripping through the SDK's internal expiry
  // check.

  it('refresh: HTTP POST hits oauth.bitrix24.tech/oauth/token/ with grant_type=refresh_token (sniff the cb)', async () => {
    // Sniff approach: after the factory installs its cb, we replace it
    // and capture what the SDK would have called. The factory's cb is
    // overwritten — but its INVOCATION is the contract we care about.
    // Drive it directly: fetch the captured cb via re-init with a
    // sniffer set BEFORE the factory's `setCustomRefreshAuth` call.
    //
    // Simplest reliable seam: spy on `setCustomRefreshAuth` to capture
    // the factory's cb first, then invoke it directly.
    const originalSet = (await import('@bitrix24/b24jssdk')).B24OAuth.prototype.setCustomRefreshAuth
    let factoryCb: CustomRefreshAuth | undefined
    const spy = vi.fn(function (this: never, cb: CustomRefreshAuth) {
      factoryCb = cb
      return originalSet.call(this, cb)
    })
    Object.defineProperty(
      (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
      'setCustomRefreshAuth',
      { value: spy, configurable: true },
    )

    try {
      await store.upsertTokens(SAMPLE_TENANT, 'install')
      const { useBitrix24OAuth } = await loadFactory()
      await useBitrix24OAuth(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)
      expect(factoryCb).toBeDefined()

      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user,task',
        domain: 'acme.bitrix24.com',
      }))

      await factoryCb!()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(url).toBe('https://oauth.bitrix24.tech/oauth/token/')
      expect(init!.method).toBe('POST')
      const body = init!.body as URLSearchParams
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('client_id')).toBe('app.cid.12345')
      expect(body.get('client_secret')).toBe('super-secret')
      expect(body.get('refresh_token')).toBe('refresh-token-v1')

      // Tokens persisted, status updated.
      const row = store.getTokens(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)!
      expect(row.accessToken).toBe('new-access')
      expect(row.refreshToken).toBe('new-refresh')

      const { _readRefreshStatus } = await loadFactory()
      expect(_readRefreshStatus().lastRefreshOk).not.toBeNull()
      expect(_readRefreshStatus().lastRefreshFail).toBeNull()

      // Log events
      expect(loggerCalls.find(c => c.event === 'oauth.refresh.start')).toBeDefined()
      expect(loggerCalls.find(c => c.event === 'oauth.refresh.ok')).toBeDefined()
    }
    finally {
      Object.defineProperty(
        (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
        'setCustomRefreshAuth',
        { value: originalSet, configurable: true },
      )
    }
  })

  it('refresh: invalid_grant fires markRefreshFailed + evicts cache + updates lastRefreshFail', async () => {
    const originalSet = (await import('@bitrix24/b24jssdk')).B24OAuth.prototype.setCustomRefreshAuth
    let factoryCb: CustomRefreshAuth | undefined
    const spy = vi.fn(function (this: never, cb: CustomRefreshAuth) {
      factoryCb = cb
      return originalSet.call(this, cb)
    })
    Object.defineProperty(
      (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
      'setCustomRefreshAuth',
      { value: spy, configurable: true },
    )

    try {
      await store.upsertTokens(SAMPLE_TENANT, 'install')
      const { bearerHash } = await store.createMcpToken(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId, 'laptop', 'install')
      const { useBitrix24OAuth } = await loadFactory()
      const cached1 = await useBitrix24OAuth(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)

      fetchMock.mockResolvedValue(jsonResp(400, { error: 'invalid_grant' }))

      await expect(factoryCb!()).rejects.toThrow(/invalid_grant/)

      // Bearer was revoked.
      expect(store.findByBearerHash(bearerHash)).toBeUndefined()

      // Cache evicted — next call gets a fresh instance (after we
      // re-seed the row, otherwise it throws). The token row stays —
      // markRefreshFailed only touches mcp_tokens.
      const cached2 = await useBitrix24OAuth(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)
      expect(cached2).not.toBe(cached1)

      const { _readRefreshStatus } = await loadFactory()
      expect(_readRefreshStatus().lastRefreshFail).not.toBeNull()

      expect(loggerCalls.find(c => c.event === 'oauth.refresh.fail.invalid-grant')).toBeDefined()
    }
    finally {
      Object.defineProperty(
        (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
        'setCustomRefreshAuth',
        { value: originalSet, configurable: true },
      )
    }
  })

  it('refresh: oauth_tokens row deleted mid-flight (uninstall race) → distinct tenant-deleted event, NO markRefreshFailed', async () => {
    // Issue #223 item 1: a concurrent deleteTenant() between the SDK's expiry
    // check and the store read makes `current` null. This MUST NOT be confused
    // with a genuine invalid_grant (revoked refresh token): it's a benign
    // uninstall race, so no Bearer revocation fires and it gets its own event.
    const originalSet = (await import('@bitrix24/b24jssdk')).B24OAuth.prototype.setCustomRefreshAuth
    let factoryCb: CustomRefreshAuth | undefined
    const spy = vi.fn(function (this: never, cb: CustomRefreshAuth) {
      factoryCb = cb
      return originalSet.call(this, cb)
    })
    Object.defineProperty(
      (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
      'setCustomRefreshAuth',
      { value: spy, configurable: true },
    )

    try {
      await store.upsertTokens(SAMPLE_TENANT, 'install')
      await store.createMcpToken(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId, 'laptop', 'install')
      const { useBitrix24OAuth } = await loadFactory()
      await useBitrix24OAuth(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)
      expect(factoryCb).toBeDefined()

      // The uninstall happens AFTER the instance is built/cached but BEFORE
      // the refresh callback reads the row — the race the guard defends.
      const markSpy = vi.spyOn(store, 'markRefreshFailed')
      await store.deleteTenant(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId, 'user')

      await expect(factoryCb!()).rejects.toThrow(/vanished/)

      // markRefreshFailed NOT called — there is nothing to revoke (the CASCADE
      // already dropped this tenant's Bearers on deleteTenant).
      expect(markSpy).not.toHaveBeenCalled()

      // Distinct event — and NOT the invalid-grant event that would mislead
      // a "refresh token revoked" alert.
      expect(loggerCalls.find(c => c.event === 'oauth.refresh.fail.tenant-deleted')).toBeDefined()
      expect(loggerCalls.find(c => c.event === 'oauth.refresh.fail.invalid-grant')).toBeUndefined()

      // health signal stays CLEAN (#223 review): a benign uninstall race must
      // not bump lastRefreshFail, or it re-creates the false-alarm at the
      // health-endpoint level that the distinct event exists to avoid.
      const { _readRefreshStatus } = await loadFactory()
      expect(_readRefreshStatus().lastRefreshFail).toBeNull()

      // fetch never happened — we bailed before the network call.
      expect(fetchMock).not.toHaveBeenCalled()
    }
    finally {
      Object.defineProperty(
        (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
        'setCustomRefreshAuth',
        { value: originalSet, configurable: true },
      )
    }
  })

  it('refresh: response with `expires` (unix ts) and no `expires_in` → accessExpiresAt = expires', async () => {
    // Issue #223 item 2: Bitrix24 prod sends `expires` (absolute unix seconds)
    // as the primary field. All other refresh tests pass only `expires_in`, so
    // the `data.expires ?? …` branch was uncovered. If Bitrix24 ever drops
    // `expires_in`, expiry must still come from `expires`, not the +3600
    // fallback.
    const originalSet = (await import('@bitrix24/b24jssdk')).B24OAuth.prototype.setCustomRefreshAuth
    let factoryCb: CustomRefreshAuth | undefined
    const spy = vi.fn(function (this: never, cb: CustomRefreshAuth) {
      factoryCb = cb
      return originalSet.call(this, cb)
    })
    Object.defineProperty(
      (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
      'setCustomRefreshAuth',
      { value: spy, configurable: true },
    )

    try {
      await store.upsertTokens(SAMPLE_TENANT, 'install')
      const { useBitrix24OAuth } = await loadFactory()
      await useBitrix24OAuth(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)
      expect(factoryCb).toBeDefined()

      const expiresAt = Math.floor(Date.now() / 1000) + 7200
      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        // NOTE: `expires` present, `expires_in` deliberately ABSENT.
        expires: expiresAt,
        scope: 'user,task',
        domain: 'acme.bitrix24.com',
      }))

      await factoryCb!()

      // Persisted expiry comes from `expires`, NOT the +3600 fallback.
      const row = store.getTokens(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)!
      expect(row.accessExpiresAt).toBe(expiresAt)

      const okLog = loggerCalls.find(c => c.event === 'oauth.refresh.ok')
      expect(okLog?.ctx).toMatchObject({ accessExpiresAt: expiresAt })
    }
    finally {
      Object.defineProperty(
        (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
        'setCustomRefreshAuth',
        { value: originalSet, configurable: true },
      )
    }
  })

  it('refresh: transient 5xx → throws WITHOUT markRefreshFailed (Bearers stay active)', async () => {
    const originalSet = (await import('@bitrix24/b24jssdk')).B24OAuth.prototype.setCustomRefreshAuth
    let factoryCb: CustomRefreshAuth | undefined
    const spy = vi.fn(function (this: never, cb: CustomRefreshAuth) {
      factoryCb = cb
      return originalSet.call(this, cb)
    })
    Object.defineProperty(
      (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
      'setCustomRefreshAuth',
      { value: spy, configurable: true },
    )

    try {
      await store.upsertTokens(SAMPLE_TENANT, 'install')
      const { bearerHash } = await store.createMcpToken(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId, 'laptop', 'install')
      const { useBitrix24OAuth } = await loadFactory()
      await useBitrix24OAuth(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)

      fetchMock.mockResolvedValue(jsonResp(503, { error: 'service_unavailable' }))

      await expect(factoryCb!()).rejects.toThrow(/refresh failed/)

      // Bearer SURVIVES — transient errors don't kill credentials.
      expect(store.findByBearerHash(bearerHash)).toBeDefined()

      const { _readRefreshStatus } = await loadFactory()
      expect(_readRefreshStatus().lastRefreshFail).not.toBeNull()

      expect(loggerCalls.find(c => c.event === 'oauth.refresh.fail.transient')).toBeDefined()
    }
    finally {
      Object.defineProperty(
        (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
        'setCustomRefreshAuth',
        { value: originalSet, configurable: true },
      )
    }
  })

  it('refresh: raw refresh_token never appears in any logged context', async () => {
    const originalSet = (await import('@bitrix24/b24jssdk')).B24OAuth.prototype.setCustomRefreshAuth
    let factoryCb: CustomRefreshAuth | undefined
    const spy = vi.fn(function (this: never, cb: CustomRefreshAuth) {
      factoryCb = cb
      return originalSet.call(this, cb)
    })
    Object.defineProperty(
      (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
      'setCustomRefreshAuth',
      { value: spy, configurable: true },
    )

    try {
      await store.upsertTokens(SAMPLE_TENANT, 'install')
      const { useBitrix24OAuth } = await loadFactory()
      await useBitrix24OAuth(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)

      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'NEW-ACCESS', refresh_token: 'NEW-REFRESH', expires_in: 3600,
        scope: 'user', domain: 'acme.bitrix24.com',
      }))

      await factoryCb!()

      for (const call of loggerCalls) {
        const dump = JSON.stringify(call.ctx ?? {})
        expect(dump, `event ${call.event} leaked refresh_token`).not.toContain('refresh-token-v1')
        expect(dump, `event ${call.event} leaked NEW-REFRESH`).not.toContain('NEW-REFRESH')
        expect(dump, `event ${call.event} leaked access_token`).not.toContain('NEW-ACCESS')
        expect(dump, `event ${call.event} leaked client_secret`).not.toContain('super-secret')
      }
    }
    finally {
      Object.defineProperty(
        (await import('@bitrix24/b24jssdk')).B24OAuth.prototype,
        'setCustomRefreshAuth',
        { value: originalSet, configurable: true },
      )
    }
  })
})

describe('useBitrix24OAuth — domain & endpoint validation (#220)', () => {
  // Reusable sniffer: capture the factory's refresh callback so we can
  // invoke it directly with whatever response shape we want.
  //
  // If `useBitrix24OAuth(...)` throws before this returns, the prototype
  // patch is not restored here — but `beforeEach`'s `vi.resetModules()` +
  // the fresh `@bitrix24/b24jssdk` import per test contains the leak to
  // this `it`. Callers still wrap the `restore()` in their own `finally`.
  async function captureFactoryCb(): Promise<{
    factoryCb: CustomRefreshAuth
    restore: () => void
  }> {
    const sdk = await import('@bitrix24/b24jssdk')
    const originalSet = sdk.B24OAuth.prototype.setCustomRefreshAuth
    let captured: CustomRefreshAuth | undefined
    const spy = vi.fn(function (this: never, cb: CustomRefreshAuth) {
      captured = cb
      return originalSet.call(this, cb)
    })
    Object.defineProperty(sdk.B24OAuth.prototype, 'setCustomRefreshAuth', { value: spy, configurable: true })

    await store.upsertTokens(SAMPLE_TENANT, 'install')
    const { useBitrix24OAuth } = await loadFactory()
    await useBitrix24OAuth(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)
    if (!captured) throw new Error('factory cb was not captured')

    return {
      factoryCb: captured,
      restore: () => {
        Object.defineProperty(
          sdk.B24OAuth.prototype,
          'setCustomRefreshAuth',
          { value: originalSet, configurable: true },
        )
      },
    }
  }

  // ============================================================
  //  setLogger — defence-in-depth on the SDK's stdout log line
  // ============================================================

  it('attaches a redacting logger to every B24OAuth instance on construction', async () => {
    // Sniff `setLogger` on the prototype so we observe the factory's
    // single call without depending on the SDK's internal storage.
    // A future regression that drops the wiring leaves the spy at zero
    // calls — the exact failure mode #220 was filed for.
    const sdk = await import('@bitrix24/b24jssdk')
    const originalSet = sdk.B24OAuth.prototype.setLogger
    const setLoggerSpy = vi.fn(function (this: never, logger: unknown) {
      return originalSet.call(this, logger as never)
    })
    Object.defineProperty(sdk.B24OAuth.prototype, 'setLogger', { value: setLoggerSpy, configurable: true })
    try {
      await store.upsertTokens(SAMPLE_TENANT, 'install')
      const { useBitrix24OAuth } = await loadFactory()
      await useBitrix24OAuth(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)
      expect(setLoggerSpy).toHaveBeenCalledTimes(1)
      // The wired logger object must NOT be the SDK's default ConsoleHandler;
      // it has to be the redactor wrapper sourced from our `useLogger()`
      // mock above.
      const wired = setLoggerSpy.mock.calls[0]![0] as { info: (event: string, ctx?: Record<string, unknown>) => Promise<void> }
      expect(typeof wired.info).toBe('function')
      // The wired logger must be the REDACTING wrapper, not a bare logger:
      // push a webhook-secret-shaped URL through it and confirm the secret
      // segment comes out `<REDACTED>`. A regression that drops
      // `makeRedactingLogger` (wiring `useLogger()` raw) fails here — which
      // is the exact credential-leak #220 guards against.
      await wired.info('https://acme.bitrix24.com/rest/1/SUPERSECRETWEBHOOK', { sample: 1 })
      const rec = loggerCalls.find(c => c.event.includes('acme.bitrix24.com'))
      expect(rec).toBeDefined()
      expect(rec!.event).toContain('<REDACTED>')
      expect(rec!.event).not.toContain('SUPERSECRETWEBHOOK')
    }
    finally {
      Object.defineProperty(sdk.B24OAuth.prototype, 'setLogger', { value: originalSet, configurable: true })
    }
  })

  // ============================================================
  //  data.domain — refuse swap of tenant portal mid-refresh
  // ============================================================

  it('refresh: refuses domain ≠ current.portalDomain (no persist, throws domain-mismatch)', async () => {
    const { factoryCb, restore } = await captureFactoryCb()
    try {
      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user,task',
        // Allow-listed value, but a DIFFERENT tenant — attacker / upstream
        // bug attempting to swap portals mid-refresh.
        domain: 'evil.bitrix24.com',
      }))

      await expect(factoryCb()).rejects.toThrow(/domain-mismatch/)

      // Tokens were NOT persisted — old values still on the row.
      const row = store.getTokens(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)!
      expect(row.accessToken).toBe(SAMPLE_TENANT.accessToken)
      expect(row.refreshToken).toBe(SAMPLE_TENANT.refreshToken)
      expect(row.portalDomain).toBe(SAMPLE_TENANT.portalDomain)

      // Logged as transient (Bearers stay active — this is an
      // upstream anomaly, not a revocation).
      const fail = loggerCalls.find(c => c.event === 'oauth.refresh.fail.transient')
      expect(fail).toBeDefined()
      expect(fail!.ctx).toMatchObject({ reason: 'domain-mismatch', expected: SAMPLE_TENANT.portalDomain })
    }
    finally { restore() }
  })

  it('refresh: refuses domain that fails the allow-list (e.g. attacker.example.com)', async () => {
    const { factoryCb, restore } = await captureFactoryCb()
    try {
      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user,task',
        domain: 'attacker.example.com',
      }))
      await expect(factoryCb()).rejects.toThrow(/domain-mismatch/)
      const row = store.getTokens(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)!
      expect(row.accessToken).toBe(SAMPLE_TENANT.accessToken)
    }
    finally { restore() }
  })

  it('refresh: omitting data.domain is allowed — falls back to stored portal (legitimate upstream)', async () => {
    const { factoryCb, restore } = await captureFactoryCb()
    try {
      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user,task',
        // no domain field
      }))
      await factoryCb()
      const row = store.getTokens(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId)!
      expect(row.accessToken).toBe('new-access')
      expect(row.portalDomain).toBe(SAMPLE_TENANT.portalDomain)
    }
    finally { restore() }
  })

  // ============================================================
  //  client_endpoint / server_endpoint — no-throw substitution
  // ============================================================

  it('refresh: malicious client_endpoint is substituted with the canonical safe URL + logged', async () => {
    const { factoryCb, restore } = await captureFactoryCb()
    try {
      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user,task',
        domain: SAMPLE_TENANT.portalDomain,
        // Attacker-supplied — hostname ≠ stored portal.
        client_endpoint: 'https://attacker.example.com/rest/',
      }))
      const result = await factoryCb()
      // No throw, no DB taint: tokens persisted, but the SDK gets the
      // canonical fallback so all subsequent REST calls hit the real
      // tenant portal.
      expect(result.client_endpoint).toBe(`https://${SAMPLE_TENANT.portalDomain}/rest/`)
      const reject = loggerCalls.find(
        c => c.event === 'oauth.endpoint.reject' && c.ctx?.field === 'client_endpoint',
      )
      expect(reject).toBeDefined()
      expect(reject!.ctx).toMatchObject({ expectedHost: SAMPLE_TENANT.portalDomain })
    }
    finally { restore() }
  })

  it('refresh: HTTP (non-HTTPS) client_endpoint is rejected → safe fallback', async () => {
    const { factoryCb, restore } = await captureFactoryCb()
    try {
      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user,task',
        domain: SAMPLE_TENANT.portalDomain,
        client_endpoint: `http://${SAMPLE_TENANT.portalDomain}/rest/`,
      }))
      const result = await factoryCb()
      expect(result.client_endpoint).toBe(`https://${SAMPLE_TENANT.portalDomain}/rest/`)
    }
    finally { restore() }
  })

  it('refresh: legitimate client_endpoint that matches the stored portal is preserved', async () => {
    const { factoryCb, restore } = await captureFactoryCb()
    try {
      const goodUrl = `https://${SAMPLE_TENANT.portalDomain}/rest/`
      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user,task',
        domain: SAMPLE_TENANT.portalDomain,
        client_endpoint: goodUrl,
      }))
      const result = await factoryCb()
      expect(result.client_endpoint).toBe(goodUrl)
    }
    finally { restore() }
  })

  it('refresh: server_endpoint substitution — unknown host is replaced + logged', async () => {
    const { factoryCb, restore } = await captureFactoryCb()
    try {
      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user,task',
        domain: SAMPLE_TENANT.portalDomain,
        server_endpoint: 'https://attacker.example.com/rest/',
      }))
      const result = await factoryCb()
      expect(result.server_endpoint).toBe('https://oauth.bitrix.info/rest/')
      const reject = loggerCalls.find(
        c => c.event === 'oauth.endpoint.reject' && c.ctx?.field === 'server_endpoint',
      )
      expect(reject).toBeDefined()
    }
    finally { restore() }
  })

  it('refresh: server_endpoint at oauth.bitrix24.tech is preserved (known central host)', async () => {
    const { factoryCb, restore } = await captureFactoryCb()
    try {
      const goodUrl = 'https://oauth.bitrix24.tech/rest/'
      fetchMock.mockResolvedValue(jsonResp(200, {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'user,task',
        domain: SAMPLE_TENANT.portalDomain,
        server_endpoint: goodUrl,
      }))
      const result = await factoryCb()
      expect(result.server_endpoint).toBe(goodUrl)
    }
    finally { restore() }
  })
})

describe('useBitrix24OAuth — _readRefreshStatus', () => {
  it('starts both fields at null on a fresh process', async () => {
    const { _readRefreshStatus } = await loadFactory()
    expect(_readRefreshStatus()).toEqual({ lastRefreshOk: null, lastRefreshFail: null })
  })
})
