import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Bitrix24Module from '../../server/utils/bitrix24'

const fromWebhookUrl = vi.fn()
const setLogger = vi.fn()

vi.mock('@bitrix24/b24jssdk', () => ({
  B24Hook: { fromWebhookUrl },
}))

vi.mock('~/server/utils/logger', () => ({
  // useLogger is invoked from bitrix24.ts to wire the SDK's logger; the
  // bitrix24 unit suite doesn't care about its output, only that it doesn't
  // throw or crash the singleton bootstrap.
  useLogger: () => ({ debug: () => {}, info: () => {}, warning: () => {}, error: () => {} }),
}))

const runtimeConfig: { bitrix24WebhookUrl: string } = { bitrix24WebhookUrl: '' }

vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

async function loadFresh(): Promise<typeof Bitrix24Module> {
  // `vi.resetModules()` drops the module-scoped singleton cache; the dynamic
  // import then re-evaluates server/utils/bitrix24.ts from scratch. This is
  // why the module doesn't need to export a test-only reset hook.
  vi.resetModules()
  return await import('../../server/utils/bitrix24')
}

describe('useBitrix24', () => {
  beforeEach(() => {
    fromWebhookUrl.mockReset()
    setLogger.mockReset()
    // Returns an object with `setLogger` so the wrapper in `useBitrix24` —
    // which calls `client.setLogger(useLogger())` — doesn't crash.
    fromWebhookUrl.mockImplementation((url: string) => ({ url, setLogger }))
    runtimeConfig.bitrix24WebhookUrl = ''
  })

  it('throws when the webhook URL is missing', async () => {
    const { useBitrix24 } = await loadFresh()
    expect(() => useBitrix24()).toThrow(/NUXT_BITRIX24_WEBHOOK_URL/)
  })

  it('constructs B24Hook with the webhook URL on first call', async () => {
    runtimeConfig.bitrix24WebhookUrl = 'https://example.bitrix24.ru/rest/1/abc/'
    const { useBitrix24 } = await loadFresh()
    useBitrix24()
    expect(fromWebhookUrl).toHaveBeenCalledWith('https://example.bitrix24.ru/rest/1/abc/')
  })

  it('wires the project logger into the SDK via setLogger on first construction', async () => {
    runtimeConfig.bitrix24WebhookUrl = 'https://example.bitrix24.ru/rest/1/abc/'
    const { useBitrix24 } = await loadFresh()
    useBitrix24()
    expect(setLogger).toHaveBeenCalledTimes(1)
  })

  it('returns the same instance on subsequent calls (singleton)', async () => {
    runtimeConfig.bitrix24WebhookUrl = 'https://example.bitrix24.ru/rest/1/abc/'
    const { useBitrix24 } = await loadFresh()
    const first = useBitrix24()
    const second = useBitrix24()
    expect(first).toBe(second)
    expect(fromWebhookUrl).toHaveBeenCalledTimes(1)
    // setLogger only called once across both useBitrix24() calls
    expect(setLogger).toHaveBeenCalledTimes(1)
  })

  it('rewraps a malformed-URL throw from fromWebhookUrl with operator-friendly hint', async () => {
    runtimeConfig.bitrix24WebhookUrl = 'totally-not-a-url'
    fromWebhookUrl.mockImplementation(() => {
      throw new Error('Invalid webhook URL format')
    })

    const { useBitrix24 } = await loadFresh()
    expect(() => useBitrix24()).toThrow(/NUXT_BITRIX24_WEBHOOK_URL is not a valid Bitrix24 webhook URL/)
    expect(() => useBitrix24()).toThrow(/Invalid webhook URL format/) // original SDK reason included
  })

  it('passes a LoggerInterface-shaped object into client.setLogger', async () => {
    runtimeConfig.bitrix24WebhookUrl = 'https://example.bitrix24.ru/rest/1/abc/'
    const { useBitrix24 } = await loadFresh()
    useBitrix24()
    // Verify shape rather than identity — useLogger() is mocked and we want
    // to know that whatever we pass exposes the LoggerInterface contract
    // (debug/info/warning/error). Catches regressions where the wiring
    // accidentally passes a wrong object.
    const passed = setLogger.mock.calls[0]![0] as Record<string, unknown>
    expect(typeof passed.debug).toBe('function')
    expect(typeof passed.info).toBe('function')
    expect(typeof passed.warning).toBe('function')
    expect(typeof passed.error).toBe('function')
  })
})
