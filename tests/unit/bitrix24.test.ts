import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Bitrix24Module from '../../server/utils/bitrix24'

const fromWebhookUrl = vi.fn()
const setLogger = vi.fn()
const setRestrictionManagerParams = vi.fn()

vi.mock('@bitrix24/b24jssdk', () => ({
  B24Hook: { fromWebhookUrl },
  ParamsFactory: { getDefault: () => ({}) },
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
    setRestrictionManagerParams.mockReset()
    // `useBitrix24` registers a hard error code via this async method; resolve
    // it so the fire-and-forget `.catch` chain doesn't reject in tests.
    setRestrictionManagerParams.mockResolvedValue(undefined)
    // Returns an object with `setLogger` + `setRestrictionManagerParams` so the
    // bootstrap in `useBitrix24` doesn't crash.
    fromWebhookUrl.mockImplementation((url: string) => ({ url, setLogger, setRestrictionManagerParams }))
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

  it('registers Bitrix24 error 1048582 as a non-retryable hard error code (#127)', async () => {
    // 1048582 ("action not available") is a permanent lifecycle-transition
    // rejection; without this the SDK retries it 3x with backoff. Remove once
    // upstream bitrix24/b24jssdk#46 ships the built-in.
    runtimeConfig.bitrix24WebhookUrl = 'https://example.bitrix24.ru/rest/1/abc/'
    const { useBitrix24 } = await loadFresh()
    useBitrix24()
    expect(setRestrictionManagerParams).toHaveBeenCalledTimes(1)
    const passed = setRestrictionManagerParams.mock.calls[0]![0] as { hardErrorCodes?: string[] }
    expect(passed.hardErrorCodes).toContain('1048582')
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

  it('redacts the webhook secret if the SDK error message echoes the input URL (issue #26)', async () => {
    // If the operator misconfigures the env var with a real-but-malformed
    // webhook (e.g. trailing garbage), the SDK's parse error can include the
    // raw URL — secret and all — verbatim in its message. The rewrap path
    // interpolates that message into the new Error, which Nuxt's error
    // handler will log. `redactString(rawReason)` must scrub the secret
    // before it reaches the rewrapped message.
    runtimeConfig.bitrix24WebhookUrl = 'https://example.bitrix24.ru/rest/1/SUPERSECRETXYZ/garbage'
    fromWebhookUrl.mockImplementation(() => {
      throw new Error('Invalid webhook URL format: https://example.bitrix24.ru/rest/1/SUPERSECRETXYZ/garbage')
    })

    const { useBitrix24 } = await loadFresh()
    let caught: Error | undefined
    try { useBitrix24() } catch (err) { caught = err as Error }

    expect(caught).toBeDefined()
    expect(caught!.message).not.toContain('SUPERSECRETXYZ')
    expect(caught!.message).toContain('<REDACTED>')
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

  it('wraps the logger with the URL redactor before passing it into setLogger (issue #26)', async () => {
    // The wrapper must NOT pass useLogger() raw — the SDK's HTTP layer
    // logs the full webhook URL on every request, so an unwrapped logger
    // leaks the secret. We pin the wiring by inspecting what setLogger
    // received and asserting the wrapped functions redact URLs before
    // they would hit the inner logger.
    runtimeConfig.bitrix24WebhookUrl = 'https://example.bitrix24.ru/rest/1/abc/'
    const innerLogs: { method: string; args: unknown[] }[] = []
    vi.doMock('~/server/utils/logger', () => ({
      useLogger: () => ({
        log: (...args: unknown[]) => {
          innerLogs.push({ method: 'log', args })
          return Promise.resolve()
        },
        debug: (...args: unknown[]) => {
          innerLogs.push({ method: 'debug', args })
          return Promise.resolve()
        },
        info: (...args: unknown[]) => {
          innerLogs.push({ method: 'info', args })
          return Promise.resolve()
        },
        notice: (...args: unknown[]) => {
          innerLogs.push({ method: 'notice', args })
          return Promise.resolve()
        },
        warning: (...args: unknown[]) => {
          innerLogs.push({ method: 'warning', args })
          return Promise.resolve()
        },
        error: (...args: unknown[]) => {
          innerLogs.push({ method: 'error', args })
          return Promise.resolve()
        },
        critical: () => Promise.resolve(),
        alert: () => Promise.resolve(),
        emergency: () => Promise.resolve(),
      }),
    }))
    const { useBitrix24 } = await loadFresh()
    useBitrix24()

    // What the SDK would do internally — call the logger we handed it
    // with a webhook URL as a context value. The inner logger should
    // receive the REDACTED form, not the raw URL.
    const passed = setLogger.mock.calls[0]![0] as { info: (msg: string, ctx?: Record<string, unknown>) => Promise<void> }
    await passed.info('post/send', {
      method: 'https://example.bitrix24.ru/rest/1/THE_SECRET/tasks.task.get',
      requestId: 'r1',
    })

    expect(innerLogs).toHaveLength(1)
    const [msg, ctx] = innerLogs[0]!.args as [string, Record<string, unknown>]
    expect(msg).toBe('post/send')
    expect(String(ctx.method)).not.toContain('THE_SECRET')
    expect(String(ctx.method)).toContain('<REDACTED>')
    expect(ctx.requestId).toBe('r1')

    vi.doUnmock('~/server/utils/logger')
  })
})
