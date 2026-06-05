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

describe('oauth-schema — pruneExpiredStates scheduler (issue #211)', () => {
  it('arms a 5-minute setInterval that calls pruneExpiredStates', async () => {
    runtimeConfig.bitrix24OauthEnabled = true
    const pruneExpiredStates = vi.fn().mockReturnValue(0)
    useTokenStore.mockReturnValue({ pruneExpiredStates })

    vi.useFakeTimers()
    try {
      const plugin = await loadPlugin()
      plugin({ hooks: { hook: vi.fn() } })
      expect(pruneExpiredStates).not.toHaveBeenCalled() // not on boot
      vi.advanceTimersByTime(5 * 60 * 1000) // one tick
      expect(pruneExpiredStates).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(5 * 60 * 1000) // second tick
      expect(pruneExpiredStates).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('logs oauth.state.prune.ok when rows were pruned (>0); silent when 0', async () => {
    runtimeConfig.bitrix24OauthEnabled = true
    const pruneExpiredStates = vi.fn()
      .mockReturnValueOnce(0) // first tick: empty, silent
      .mockReturnValueOnce(3) // second tick: 3 rows
    useTokenStore.mockReturnValue({ pruneExpiredStates })
    loggerInfo.mockClear()

    vi.useFakeTimers()
    try {
      const plugin = await loadPlugin()
      plugin({ hooks: { hook: vi.fn() } })
      vi.advanceTimersByTime(5 * 60 * 1000)
      // First tick: 0 pruned — no log line. Only the boot-success line.
      const pruneLogs1 = loggerInfo.mock.calls.filter(c => c[0] === 'oauth.state.prune.ok')
      expect(pruneLogs1).toHaveLength(0)

      vi.advanceTimersByTime(5 * 60 * 1000)
      const pruneLogs2 = loggerInfo.mock.calls.filter(c => c[0] === 'oauth.state.prune.ok')
      expect(pruneLogs2).toHaveLength(1)
      expect(pruneLogs2[0]![1]).toEqual({ rows: 3 })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does NOT crash on prune failure — logs oauth.state.prune.fail and continues', async () => {
    runtimeConfig.bitrix24OauthEnabled = true
    const pruneErr = new Error('database is locked')
    const pruneExpiredStates = vi.fn()
      .mockImplementationOnce(() => { throw pruneErr })
      .mockReturnValueOnce(0)
    useTokenStore.mockReturnValue({ pruneExpiredStates })
    loggerError.mockClear()

    vi.useFakeTimers()
    try {
      const plugin = await loadPlugin()
      plugin({ hooks: { hook: vi.fn() } })
      // First tick throws — must be caught, logged, and survive.
      expect(() => vi.advanceTimersByTime(5 * 60 * 1000)).not.toThrow()
      expect(loggerError).toHaveBeenCalledWith('oauth.state.prune.fail', { err: pruneErr })
      // Second tick still runs — log-and-continue contract.
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(pruneExpiredStates).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('registers a Nitro `close` hook that clears the interval (no zombie timer)', async () => {
    runtimeConfig.bitrix24OauthEnabled = true
    const pruneExpiredStates = vi.fn().mockReturnValue(0)
    useTokenStore.mockReturnValue({ pruneExpiredStates })

    const hook = vi.fn()
    vi.useFakeTimers()
    try {
      const plugin = await loadPlugin()
      plugin({ hooks: { hook } })
      // Capture the close-hook callback the plugin registered.
      expect(hook).toHaveBeenCalledWith('close', expect.any(Function))
      const closeCallback = hook.mock.calls.find(c => c[0] === 'close')![1] as () => void
      // Fire the close hook — the timer is cleared.
      closeCallback()
      vi.advanceTimersByTime(60 * 60 * 1000) // one hour — should fire NOTHING
      expect(pruneExpiredStates).not.toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('flag-off: NO prune timer, NO close hook (zero behaviour for webhook-only forks)', async () => {
    runtimeConfig.bitrix24OauthEnabled = false
    useTokenStore.mockClear()
    const hook = vi.fn()
    const plugin = await loadPlugin()
    plugin({ hooks: { hook } })
    expect(hook).not.toHaveBeenCalled()
    // No timer armed — `useTokenStore` was never called either.
    expect(useTokenStore).not.toHaveBeenCalled()
  })
})
