import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LoggerModule from '../../../server/utils/logger'

// Capture the level handed to every `new ConsoleHandler(level)`. The SDK is
// mocked so the test observes the resolved level without spinning up the real
// handler stack.
const handlerLevels: number[] = []
const pushHandler = vi.fn()

vi.mock('@bitrix24/b24jssdk', () => ({
  LogLevel: {
    DEBUG: 0,
    INFO: 1,
    NOTICE: 2,
    WARNING: 3,
    ERROR: 4,
    CRITICAL: 5,
    ALERT: 6,
    EMERGENCY: 7,
  },
  ConsoleHandler: function ConsoleHandler(this: unknown, level: number) {
    handlerLevels.push(level)
  },
  Logger: {
    create: () => ({ pushHandler }),
  },
}))

async function loadFresh(): Promise<typeof LoggerModule> {
  // Drop the module-scoped singleton so each case re-resolves the level.
  vi.resetModules()
  return await import('../../../server/utils/logger')
}

const originalEnv = { ...process.env }

describe('useLogger level resolution', () => {
  beforeEach(() => {
    handlerLevels.length = 0
    pushHandler.mockReset()
    delete process.env.NUXT_LOG_LEVEL
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('honours an explicit NUXT_LOG_LEVEL (case-insensitive)', async () => {
    process.env.NUXT_LOG_LEVEL = 'warning'
    process.env.NODE_ENV = 'development'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([3]) // WARNING wins over the dev DEBUG default
  })

  it('accepts `warn` as an alias for `warning`', async () => {
    process.env.NUXT_LOG_LEVEL = 'WARN'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([3])
  })

  it('defaults to DEBUG in development when NUXT_LOG_LEVEL is unset', async () => {
    process.env.NODE_ENV = 'development'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([0])
  })

  it('defaults to INFO outside development when NUXT_LOG_LEVEL is unset', async () => {
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([1])
  })

  it('falls back to the NODE_ENV default on an unrecognised level', async () => {
    process.env.NUXT_LOG_LEVEL = 'verbose'
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([1])
  })

  it('materialises the singleton once', async () => {
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    const a = useLogger()
    const b = useLogger()
    expect(a).toBe(b)
    expect(pushHandler).toHaveBeenCalledTimes(1)
    expect(handlerLevels).toHaveLength(1)
  })
})
