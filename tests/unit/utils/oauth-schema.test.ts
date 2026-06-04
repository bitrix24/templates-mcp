/**
 * Verifies the OAuth schema-bootstrap Nitro plugin. `defineNitroPlugin`
 * is a Nitro auto-import (a global at runtime, undefined under Vitest),
 * so we stub it; the plugin's effect is observed through a mocked
 * `useTokenStore` and `useRuntimeConfig`.
 *
 * Three branches:
 *   - `OAUTH_ENABLED=false` (default): plugin must early-return without
 *     calling `useTokenStore()`. No DB file should ever be created on
 *     webhook-only forks at boot.
 *   - `OAUTH_ENABLED=true` and `useTokenStore()` succeeds: plugin logs
 *     success and returns normally.
 *   - `OAUTH_ENABLED=true` and `useTokenStore()` throws (unwritable
 *     volume, malformed `_DB_DIR`): plugin re-throws so Nitro fails the
 *     container start loudly — the operator sees the misconfig in
 *     container logs, not as a 500 hours later on the first OAuth call.
 */
import { describe, expect, it, vi } from 'vitest'

const useTokenStore = vi.fn()
vi.mock('~/server/utils/token-store', () => ({ useTokenStore }))

const loggerError = vi.fn()
const loggerInfo = vi.fn()
vi.mock('~/server/utils/logger', () => ({
  useLogger: () => ({ info: loggerInfo, error: loggerError, debug: vi.fn(), warning: vi.fn() }),
}))

const runtimeConfig: { bitrix24OauthEnabled: boolean } = { bitrix24OauthEnabled: false }
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)
vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)

interface FakeNitro {
  hooks: { hook: (name: string, cb: () => void) => void }
}

async function loadPlugin(): Promise<(nitro: FakeNitro) => void> {
  vi.resetModules()
  const mod = await import('../../../server/plugins/oauth-schema')
  return mod.default as unknown as (nitro: FakeNitro) => void
}

describe('oauth-schema Nitro plugin', () => {
  it('does NOTHING when NUXT_BITRIX24_OAUTH_ENABLED=false (default)', async () => {
    runtimeConfig.bitrix24OauthEnabled = false
    useTokenStore.mockClear()
    const plugin = await loadPlugin()
    plugin({ hooks: { hook: vi.fn() } })
    expect(useTokenStore).not.toHaveBeenCalled()
  })

  it('calls useTokenStore() once at boot when OAuth is enabled', async () => {
    runtimeConfig.bitrix24OauthEnabled = true
    useTokenStore.mockClear()
    useTokenStore.mockReturnValue({ /* a TokenStore stub is fine */ })
    loggerInfo.mockClear()
    const plugin = await loadPlugin()
    plugin({ hooks: { hook: vi.fn() } })
    expect(useTokenStore).toHaveBeenCalledTimes(1)
    expect(loggerInfo).toHaveBeenCalled()
  })

  it('re-throws when useTokenStore() fails (so Nitro fails the container start)', async () => {
    runtimeConfig.bitrix24OauthEnabled = true
    useTokenStore.mockClear()
    const bootErr = new Error('NUXT_BITRIX24_OAUTH_DB_DIR rejected: must be an absolute path')
    useTokenStore.mockImplementation(() => { throw bootErr })
    loggerError.mockClear()
    const plugin = await loadPlugin()
    expect(() => plugin({ hooks: { hook: vi.fn() } })).toThrow(/absolute path/)
    // Operator MUST see the underlying error in container logs — assert
    // the second arg carries the original Error, not an empty stub. A
    // regression here (logging a bare string or `{}`) would leave the
    // operator chasing a healthcheck failure with no message.
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('bootstrap'),
      expect.objectContaining({ err: bootErr }),
    )
  })
})
