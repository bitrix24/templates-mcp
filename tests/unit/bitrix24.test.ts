import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Bitrix24Module from '../../server/utils/bitrix24'

const fromWebhookUrl = vi.fn()

vi.mock('@bitrix24/b24jssdk', () => ({
  B24Hook: { fromWebhookUrl },
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
    // Returns an object with a `callMethod` so the wrapper in
    // `useBitrix24` has something to bind / overwrite.
    fromWebhookUrl.mockImplementation((url: string) => ({ url, callMethod: vi.fn() }))
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

  it('returns the same instance on subsequent calls (singleton)', async () => {
    runtimeConfig.bitrix24WebhookUrl = 'https://example.bitrix24.ru/rest/1/abc/'
    const { useBitrix24 } = await loadFresh()
    const first = useBitrix24()
    const second = useBitrix24()
    expect(first).toBe(second)
    expect(fromWebhookUrl).toHaveBeenCalledTimes(1)
  })

  it('routes every callMethod through the rate limiter before delegating to the SDK', async () => {
    runtimeConfig.bitrix24WebhookUrl = 'https://example.bitrix24.ru/rest/1/abc/'
    const sdkCallMethod = vi.fn().mockResolvedValue('ok')
    fromWebhookUrl.mockImplementation(() => ({ callMethod: sdkCallMethod }))

    const { useBitrix24 } = await loadFresh()
    const client = useBitrix24()

    const result = await client.callMethod('tasks.task.start', { taskId: 1 })

    expect(result).toBe('ok')
    expect(sdkCallMethod).toHaveBeenCalledWith('tasks.task.start', { taskId: 1 })
    // We can't directly observe the rate-limiter promise from here, but the
    // dedicated suite `tests/unit/rate-limiter.test.ts` exercises its
    // back-pressure / FIFO semantics with fake timers.
  })
})
