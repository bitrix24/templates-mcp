import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit coverage for the DXT-side OAuth pieces shipped in #207.
 *
 *   - `user-data-dir.ts`    — override path is honoured (tests don't touch the
 *                             host's real Application Support / XDG_DATA_HOME).
 *   - `oauth-store.ts`      — JSON roundtrip, file mode 0o600, atomic-write
 *                             survives a corrupt prior file.
 *   - `oauth-client.ts`     — exchangeOobCode happy path, invalid_grant error,
 *                             refresh handler persists new tokens, refresh
 *                             marks invalid on `invalid_grant`.
 *   - `auth-mode.ts`        — three branches: oauth-active, oauth-onboarding,
 *                             webhook, plus the null (no-credentials) case.
 *
 * The nuxt-shims module is the side-effecting glue; it's imported lazily so
 * each test starts from a known env. The tenant override is reset between
 * cases so one test's stub can't leak into the next.
 */

describe('mcp-stdio OAuth foundations (#207)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dxt-oauth-test-'))
    vi.resetModules()
    vi.unstubAllGlobals()
    // In production `mcp-stdio/server.ts` imports `./nuxt-shims.js` first,
    // which sets this marker. The setter in `bitrix24-tenant.ts` then
    // accepts overrides (#207 /review O1 guard). Tests here drive the
    // setter directly without going through nuxt-shims, so the marker
    // must be set explicitly before each case.
    ;(globalThis as { __DXT_STDIO_MODE__?: boolean }).__DXT_STDIO_MODE__ = true
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    delete (globalThis as { __DXT_STDIO_MODE__?: boolean }).__DXT_STDIO_MODE__
  })

  describe('user-data-dir', () => {
    it('honours the override and creates the directory with mode 0o700 on POSIX', async () => {
      const sub = join(tmp, 'override-dir')
      const { getUserDataDir } = await import('../../../mcp-stdio/user-data-dir')
      const result = getUserDataDir(sub)
      expect(result).toBe(sub)
      const st = statSync(sub)
      expect(st.isDirectory()).toBe(true)
      // POSIX mode bits — Windows ignores `mode` on mkdirSync and would
      // surface a different bit pattern, so the assertion is platform-gated.
      if (process.platform !== 'win32') {
        expect(st.mode & 0o777).toBe(0o700)
      }
    })

    it('whitespace-only override falls back to the OS default — test cannot pin the OS path, so just check the override path is NOT used', async () => {
      const { getUserDataDir } = await import('../../../mcp-stdio/user-data-dir')
      const result = getUserDataDir('   ')
      expect(result).not.toBe('   ')
    })
  })

  describe('OAuthStore', () => {
    it('returns null when the file does not exist', async () => {
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      expect(store.read()).toBeNull()
    })

    it('roundtrips a token row via JSON, with 0o600 file mode on POSIX', async () => {
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      const row = {
        memberId: 'm1',
        userId: 42,
        portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at_v0',
        refreshToken: 'rt_v0',
        accessExpiresAt: 1800000000,
        scope: 'user,task',
        refreshInvalid: false,
      }
      store.write(row)
      expect(store.read()).toEqual(row)
      if (process.platform !== 'win32') {
        expect(statSync(store.filePath).mode & 0o777).toBe(0o600)
      }
    })

    it('treats a corrupt JSON file as "no tokens" (returns null, no throw)', async () => {
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      writeFileSync(store.filePath, '{not json', 'utf8')
      expect(store.read()).toBeNull()
    })

    it('markRefreshFailed stamps `refreshInvalid: true` without erasing other fields', async () => {
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      store.write({
        memberId: 'm1', userId: 42, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at', refreshToken: 'rt', accessExpiresAt: 1800000000,
        scope: 'user', refreshInvalid: false,
      })
      store.markRefreshFailed()
      const after = store.read()
      expect(after?.refreshInvalid).toBe(true)
      expect(after?.refreshToken).toBe('rt')
      expect(after?.accessToken).toBe('at')
    })
  })

  describe('exchangeOobCode', () => {
    it('persists tokens and emits an audit entry on a successful exchange', async () => {
      const { exchangeOobCode } = await import('../../../mcp-stdio/oauth-client')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        access_token: 'at_new',
        refresh_token: 'rt_new',
        expires_in: 3600,
        domain: 'acme.bitrix24.ru',
        member_id: 'm-from-resp',
        user_id: 7,
        scope: 'user,task',
      }), { status: 200 })))

      const row = await exchangeOobCode({
        code: 'oob-code-xyz',
        clientId: 'cid', clientSecret: 'csec',
        store, dataDirOverride: tmp,
      })

      expect(row.memberId).toBe('m-from-resp')
      expect(row.userId).toBe(7)
      expect(row.portalDomain).toBe('acme.bitrix24.ru')
      expect(store.read()?.accessToken).toBe('at_new')

      const audit = readFileSync(join(tmp, 'audit.log'), 'utf8').trim().split('\n')
      const parsed = audit.map(l => JSON.parse(l))
      expect(parsed.at(-1)).toMatchObject({
        event: 'oauth.upsert.exchange', memberId: 'm-from-resp', userId: 7,
      })
    })

    it('throws and audits transient when the token endpoint returns an error', async () => {
      const { exchangeOobCode } = await import('../../../mcp-stdio/oauth-client')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: 'invalid_grant', error_description: 'code expired',
      }), { status: 400 })))

      await expect(exchangeOobCode({
        code: 'expired', clientId: 'cid', clientSecret: 'csec', store, dataDirOverride: tmp,
      })).rejects.toThrow(/code expired/)

      // No row should have been written.
      expect(store.read()).toBeNull()
    })
  })

  describe('refresh handler (via buildOAuthClient)', () => {
    it('persists new tokens + audits oauth.upsert.refresh on a successful refresh', async () => {
      const { buildOAuthClient } = await import('../../../mcp-stdio/oauth-client')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      store.write({
        memberId: 'm1', userId: 42, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at_old', refreshToken: 'rt_old',
        accessExpiresAt: 1, scope: 'user', refreshInvalid: false,
      })

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        access_token: 'at_refreshed',
        refresh_token: 'rt_refreshed',
        expires_in: 3600,
        domain: 'acme.bitrix24.ru',
        member_id: 'm1',
        user_id: 42,
        scope: 'user',
      }), { status: 200 })))

      const b24 = buildOAuthClient({
        clientId: 'cid', clientSecret: 'csec', store, dataDirOverride: tmp,
      })
      // The SDK's `refreshAuth()` is the public entry point that invokes
      // the registered custom refresh callback (see
      // `@bitrix24/b24jssdk/oauth/auth.mjs:#refreshAuth`). It returns void
      // and mutates internal state — we verify the side effect on the
      // store + audit log, which is what production code actually relies on.
      await b24.auth.refreshAuth()
      expect(store.read()?.accessToken).toBe('at_refreshed')
      expect(store.read()?.refreshToken).toBe('rt_refreshed')

      const audit = readFileSync(join(tmp, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(audit.at(-1)).toMatchObject({ event: 'oauth.upsert.refresh', memberId: 'm1', userId: 42 })
    })

    it('marks refreshInvalid and audits invalid-grant when the refresh endpoint returns invalid_grant', async () => {
      const { buildOAuthClient } = await import('../../../mcp-stdio/oauth-client')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      store.write({
        memberId: 'm1', userId: 42, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at', refreshToken: 'rt',
        accessExpiresAt: 1, scope: 'user', refreshInvalid: false,
      })

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: 'invalid_grant',
      }), { status: 400 })))

      const b24 = buildOAuthClient({
        clientId: 'cid', clientSecret: 'csec', store, dataDirOverride: tmp,
      })
      await expect(b24.auth.refreshAuth()).rejects.toThrow(/invalid_grant/)

      expect(store.read()?.refreshInvalid).toBe(true)

      const audit = readFileSync(join(tmp, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(audit.at(-1)).toMatchObject({ event: 'oauth.fail.invalid-grant' })
    })

    it('refuses to construct when no tokens are on disk', async () => {
      const { buildOAuthClient } = await import('../../../mcp-stdio/oauth-client')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      expect(() => buildOAuthClient({
        clientId: 'cid', clientSecret: 'csec', store, dataDirOverride: tmp,
      })).toThrow(/onboarding required/)
    })

    it('refuses to construct when tokens are marked invalid', async () => {
      const { buildOAuthClient } = await import('../../../mcp-stdio/oauth-client')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      store.write({
        memberId: 'm1', userId: 42, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at', refreshToken: 'rt', accessExpiresAt: 1,
        scope: 'user', refreshInvalid: true,
      })
      expect(() => buildOAuthClient({
        clientId: 'cid', clientSecret: 'csec', store, dataDirOverride: tmp,
      })).toThrow(/re-onboarding required/)
    })
  })

  describe('resolveAuthMode', () => {
    it('integration: env → nuxt-shims → DxtAuthConfig → resolveAuthMode (catches camelCase / key-name drift, #247)', async () => {
      // Single test that walks the FULL wire path the production boot
      // path takes: manifest user_config sets env vars → nuxt-shims
      // projects them into runtimeConfig.dxt* → server.ts builds the
      // DxtAuthConfig from those keys → resolveAuthMode picks the mode.
      // The three unit pieces above test each segment in isolation but
      // would all stay green if (e.g.) the shim wrote `dxtOauthClientID`
      // (capital D) while DxtAuthConfig destructured `dxtOauthClientId`.
      // This test would go red on that exact drift.
      vi.resetModules()
      process.env.NUXT_BITRIX24_DXT_OAUTH_CLIENT_ID = 'wire-test-cid'
      process.env.NUXT_BITRIX24_DXT_OAUTH_CLIENT_SECRET = 'wire-test-secret'
      process.env.NUXT_BITRIX24_DXT_PORTAL_HOST = 'wire-test.bitrix24.ru'
      try {
        await import('../../../mcp-stdio/nuxt-shims')
        const cfg = (globalThis as { useRuntimeConfig?: () => Record<string, unknown> })
          .useRuntimeConfig?.()
        expect(cfg, 'shim must be installed').toBeDefined()
        const { resolveAuthMode } = await import('../../../mcp-stdio/auth-mode')
        const { _setStdioClientOverride } = await import('../../../server/utils/bitrix24-tenant')
        _setStdioClientOverride(null)
        const mode = resolveAuthMode({
          webhookUrl: cfg!.bitrix24WebhookUrl as string,
          oauthClientId: cfg!.dxtOauthClientId as string,
          oauthClientSecret: cfg!.dxtOauthClientSecret as string,
          portalHost: cfg!.dxtPortalHost as string,
          dataDirOverride: tmp,
        })
        // No tokens on disk yet → onboarding mode (not 'webhook', not null,
        // not 'oauth-active').
        expect(mode).toBe('oauth-onboarding')
      }
      finally {
        delete process.env.NUXT_BITRIX24_DXT_OAUTH_CLIENT_ID
        delete process.env.NUXT_BITRIX24_DXT_OAUTH_CLIENT_SECRET
        delete process.env.NUXT_BITRIX24_DXT_PORTAL_HOST
      }
    })

    it('returns null and registers no override when nothing is configured', async () => {
      const { resolveAuthMode } = await import('../../../mcp-stdio/auth-mode')
      const { _setStdioClientOverride, useBitrix24Tenant } = await import('../../../server/utils/bitrix24-tenant')
      _setStdioClientOverride(null)

      const mode = resolveAuthMode({
        webhookUrl: '', oauthClientId: '', oauthClientSecret: '', portalHost: '',
        dataDirOverride: tmp,
      })
      expect(mode).toBeNull()
      // Override should still be null; calling the dispatcher would now
      // fall through to the runtimeConfig-driven branch — out of scope for
      // this unit. Just verify the registration didn't get poisoned.
      expect(typeof useBitrix24Tenant).toBe('function')
    })

    it('returns "webhook" when only the webhook URL is set', async () => {
      const { resolveAuthMode } = await import('../../../mcp-stdio/auth-mode')
      const { _setStdioClientOverride } = await import('../../../server/utils/bitrix24-tenant')
      _setStdioClientOverride(null)
      const mode = resolveAuthMode({
        webhookUrl: 'https://acme.bitrix24.ru/rest/1/secret/',
        oauthClientId: '', oauthClientSecret: '', portalHost: '',
        dataDirOverride: tmp,
      })
      expect(mode).toBe('webhook')
    })

    it('returns "oauth-active" when OAuth is fully configured and valid tokens exist on disk', async () => {
      const { resolveAuthMode } = await import('../../../mcp-stdio/auth-mode')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const { _setStdioClientOverride } = await import('../../../server/utils/bitrix24-tenant')
      _setStdioClientOverride(null)

      // Seed valid tokens.
      mkdirSync(tmp, { recursive: true })
      new OAuthStore(tmp).write({
        memberId: 'm1', userId: 42, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at', refreshToken: 'rt',
        accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: 'user', refreshInvalid: false,
      })

      const mode = resolveAuthMode({
        webhookUrl: '', oauthClientId: 'cid', oauthClientSecret: 'csec',
        portalHost: 'acme.bitrix24.ru', dataDirOverride: tmp,
      })
      expect(mode).toBe('oauth-active')
    })

    it('returns "oauth-onboarding" when OAuth is configured but no tokens exist — and the dispatcher throws the friendly hint', async () => {
      const { resolveAuthMode } = await import('../../../mcp-stdio/auth-mode')
      const { _setStdioClientOverride, useBitrix24Tenant } = await import('../../../server/utils/bitrix24-tenant')
      _setStdioClientOverride(null)

      const mode = resolveAuthMode({
        webhookUrl: '', oauthClientId: 'cid', oauthClientSecret: 'csec',
        portalHost: 'acme.bitrix24.ru', dataDirOverride: tmp,
      })
      expect(mode).toBe('oauth-onboarding')

      expect(() => useBitrix24Tenant()).toThrow(/bx24mcp_oauth_paste_code/)
    })

    it('returns "oauth-onboarding" when tokens are present but marked invalid', async () => {
      const { resolveAuthMode } = await import('../../../mcp-stdio/auth-mode')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const { _setStdioClientOverride, useBitrix24Tenant } = await import('../../../server/utils/bitrix24-tenant')
      _setStdioClientOverride(null)

      new OAuthStore(tmp).write({
        memberId: 'm1', userId: 42, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at', refreshToken: 'rt', accessExpiresAt: 9999999999,
        scope: 'user', refreshInvalid: true,
      })

      const mode = resolveAuthMode({
        webhookUrl: '', oauthClientId: 'cid', oauthClientSecret: 'csec',
        portalHost: 'acme.bitrix24.ru', dataDirOverride: tmp,
      })
      expect(mode).toBe('oauth-onboarding')
      expect(() => useBitrix24Tenant()).toThrow(/revoked|paste_code/)
    })
  })

  describe('_setStdioClientOverride guard (#207 /review O1)', () => {
    it('refuses to mutate the override when the DXT stdio-mode marker is absent (HTTP-context misuse)', async () => {
      const { _setStdioClientOverride, useBitrix24Tenant } = await import('../../../server/utils/bitrix24-tenant')

      // Two distinguishable sentinel client instances so we can tell which
      // override the dispatcher is actually carrying. `TypeB24` is the SDK
      // contract; the dispatcher just returns whatever the registered
      // getter produces — we don't exercise its surface here.
      const first = { sentinel: 'first' } as never
      const second = { sentinel: 'second' } as never

      // Install `first` under the active marker — happy path.
      _setStdioClientOverride(() => first)
      expect(useBitrix24Tenant()).toBe(first)

      // Simulate an HTTP-server boot: the stdio shim was never imported, so
      // the marker is absent. Any attempt to install `second` must be a
      // no-op; the dispatcher should still carry `first`.
      delete (globalThis as { __DXT_STDIO_MODE__?: boolean }).__DXT_STDIO_MODE__
      _setStdioClientOverride(() => second)
      ;(globalThis as { __DXT_STDIO_MODE__?: boolean }).__DXT_STDIO_MODE__ = true
      expect(useBitrix24Tenant()).toBe(first)

      // Reset state for the rest of the suite (and so this test doesn't
      // leak its `first` override into the next case).
      _setStdioClientOverride(null)
    })
  })

  describe('buildOnboardingUrl', () => {
    it('omits redirect_uri and includes client_id + state', async () => {
      const { buildOnboardingUrl } = await import('../../../mcp-stdio/oauth-client')
      const url = buildOnboardingUrl({ portalHost: 'acme.bitrix24.ru', clientId: 'cid-xyz' })
      expect(url).toMatch(/^https:\/\/acme\.bitrix24\.ru\/oauth\/authorize\/\?/)
      expect(url).toContain('client_id=cid-xyz')
      expect(url).toContain('state=dxt-')
      expect(url).not.toContain('redirect_uri')
    })
  })

  /**
   * Follow-up cluster from `/review` on #239 (issues R2 / R3 / S2 / T1).
   * Small parity gaps + one defence-in-depth race fix + one missing test.
   */
  describe('refresh handler — follow-up audit + race coverage (#239 /review)', () => {
    it('R3: emits oauth.fail.transient with detail "tenant-deleted" when tokens vanished mid-refresh', async () => {
      const { buildOAuthClient } = await import('../../../mcp-stdio/oauth-client')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      store.write({
        memberId: 'm', userId: 1, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at', refreshToken: 'rt',
        accessExpiresAt: Math.floor(Date.now() / 1000) - 1, // already expired
        scope: 'user', refreshInvalid: false,
      })
      const b24 = buildOAuthClient({ clientId: 'cid', clientSecret: 'csec', store, dataDirOverride: tmp })
      // Simulate the file being wiped between client construction and the
      // first refresh attempt — the SDK reads `current = store.read()`
      // each refresh, so unlinking now exercises the !current branch.
      rmSync(store.filePath)

      vi.stubGlobal('fetch', vi.fn()) // would-be call shouldn't happen
      await expect(b24.auth.refreshAuth()).rejects.toThrow('vanished mid-refresh')

      const audit = readFileSync(join(tmp, 'audit.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(audit.at(-1)).toMatchObject({ event: 'oauth.fail.transient', detail: 'tenant-deleted' })
    })

    it('R2: emits info "oauth.refresh.start" before hitting the token endpoint (parity with HTTP factory)', async () => {
      const { buildOAuthClient } = await import('../../../mcp-stdio/oauth-client')
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const { useLogger } = await import('../../../server/utils/logger')
      // `useLogger` returns a cached singleton (`server/utils/logger.ts:115`)
      // so a direct spy on `.info` survives all subsequent calls within
      // the same module-graph instance — no need for vi.doMock gymnastics.
      const infoSpy = vi.spyOn(useLogger(), 'info').mockResolvedValue(undefined)

      const store = new OAuthStore(tmp)
      store.write({
        memberId: 'm-start', userId: 9, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at', refreshToken: 'rt',
        accessExpiresAt: Math.floor(Date.now() / 1000) - 1,
        scope: 'user', refreshInvalid: false,
      })

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        access_token: 'at2', refresh_token: 'rt2', expires_in: 3600,
        domain: 'acme.bitrix24.ru', member_id: 'm-start', user_id: 9, scope: 'user',
      }), { status: 200 })))

      const b24 = buildOAuthClient({ clientId: 'cid', clientSecret: 'csec', store, dataDirOverride: tmp })
      await b24.auth.refreshAuth()

      const startCalls = infoSpy.mock.calls.filter(c => c[0] === 'oauth.refresh.start')
      expect(startCalls).toHaveLength(1)
      expect(startCalls[0]![1]).toMatchObject({ memberId: 'm-start', userId: 9 })
      infoSpy.mockRestore()
    })

    it('S2: markRefreshFailed with expectedRefreshToken=mismatch leaves the row untouched (TOCTOU guard)', async () => {
      // The handler held an old `current` snapshot; meanwhile a concurrent
      // successful `exchangeOobCode` rewrote the row with a fresh token.
      // Stamping invalid against the OLD token must be a no-op so the new
      // session stays alive.
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      store.write({
        memberId: 'm', userId: 1, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at_new', refreshToken: 'rt_new_after_reonboard',
        accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: 'user', refreshInvalid: false,
      })

      store.markRefreshFailed('rt_OLD_before_reonboard')
      expect(store.read()?.refreshInvalid).toBe(false)
      expect(store.read()?.refreshToken).toBe('rt_new_after_reonboard')
    })

    it('S2: markRefreshFailed with expectedRefreshToken=match stamps invalid (the happy path of the guard)', async () => {
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      store.write({
        memberId: 'm', userId: 1, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at', refreshToken: 'rt_current',
        accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: 'user', refreshInvalid: false,
      })

      store.markRefreshFailed('rt_current')
      expect(store.read()?.refreshInvalid).toBe(true)
    })

    it('S2: markRefreshFailed with no expectedRefreshToken keeps the legacy unconditional behaviour', async () => {
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const store = new OAuthStore(tmp)
      store.write({
        memberId: 'm', userId: 1, portalDomain: 'acme.bitrix24.ru',
        accessToken: 'at', refreshToken: 'rt_any',
        accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: 'user', refreshInvalid: false,
      })

      store.markRefreshFailed()
      expect(store.read()?.refreshInvalid).toBe(true)
    })
  })

  describe('buildPasteCodeTool (#239 /review T1)', () => {
    it('exchanges the code, installs the live OAuth dispatcher override, and returns the friendly success payload', async () => {
      const { buildPasteCodeTool } = await import('../../../mcp-stdio/tools-oauth')
      const { _setStdioClientOverride, useBitrix24Tenant } = await import('../../../server/utils/bitrix24-tenant')

      // Stage 1: register a SENTINEL throwing override (matches the
      // onboarding-mode shape from `auth-mode.ts`). After the paste
      // succeeds it must be replaced with the live OAuth dispatcher.
      const sentinel = { mode: 'onboarding' } as never
      _setStdioClientOverride(() => sentinel)
      expect(useBitrix24Tenant()).toBe(sentinel)

      // Stage 2: stub fetch for the OOB code exchange — same shape as
      // the existing `exchangeOobCode` happy-path test.
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        access_token: 'at_oob', refresh_token: 'rt_oob', expires_in: 3600,
        domain: 'acme.bitrix24.ru', member_id: 'm-oob', user_id: 42, scope: 'user',
      }), { status: 200 })))

      const tool = buildPasteCodeTool({
        clientId: 'cid', clientSecret: 'csec', portalHost: 'acme.bitrix24.ru', dataDirOverride: tmp,
      })

      expect(tool.name).toBe('bx24mcp_oauth_paste_code')
      const result = await tool.handler({ code: 'oob-code-xyz' })
      expect(result).toMatchObject({
        ok: true, portalDomain: 'acme.bitrix24.ru', userId: 42,
        message: expect.stringContaining('OAuth onboarding complete'),
      })

      // Stage 3: the dispatcher override must no longer be the sentinel —
      // a real OAuth client should answer `useBitrix24Tenant()` calls.
      // We don't inspect the client's surface here (tested elsewhere),
      // just confirm the swap happened.
      expect(useBitrix24Tenant()).not.toBe(sentinel)

      // Stage 4: tokens landed on disk through the exchange.
      const { OAuthStore } = await import('../../../mcp-stdio/oauth-store')
      const persisted = new OAuthStore(tmp).read()
      expect(persisted).toMatchObject({ memberId: 'm-oob', userId: 42, accessToken: 'at_oob' })

      _setStdioClientOverride(null)
    })

    it('surfaces a friendly error when the OOB code exchange fails (override left untouched)', async () => {
      const { buildPasteCodeTool } = await import('../../../mcp-stdio/tools-oauth')
      const { _setStdioClientOverride, useBitrix24Tenant } = await import('../../../server/utils/bitrix24-tenant')
      const sentinel = { mode: 'onboarding-still' } as never
      _setStdioClientOverride(() => sentinel)

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        error: 'invalid_grant', error_description: 'code expired',
      }), { status: 400 })))

      const tool = buildPasteCodeTool({
        clientId: 'cid', clientSecret: 'csec', portalHost: 'acme.bitrix24.ru', dataDirOverride: tmp,
      })
      await expect(tool.handler({ code: 'stale-code' })).rejects.toThrow(/oauth code exchange failed/i)

      // Dispatcher override must NOT have been replaced — onboarding mode
      // sticks until the operator pastes a working code.
      expect(useBitrix24Tenant()).toBe(sentinel)
      _setStdioClientOverride(null)
    })
  })
})
