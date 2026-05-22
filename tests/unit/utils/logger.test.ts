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
    // Reset to a known-clean baseline FIRST (so an inherited NODE_ENV /
    // LOG_LEVEL from the CI shell can't leak into the first case), then drop
    // the level-affecting keys.
    process.env = { ...originalEnv }
    delete process.env.NUXT_LOG_LEVEL
    delete process.env.LOG_LEVEL
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

  it.each([
    ['debug', 0],
    ['info', 1],
    ['notice', 2],
    ['warning', 3],
    ['warn', 3],
    ['error', 4],
    ['critical', 5],
    ['alert', 6],
    ['emergency', 7],
  ])('maps every recognised level name: %s → %i', async (name, expected) => {
    process.env.NUXT_LOG_LEVEL = name
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([expected])
  })

  it('trims surrounding whitespace and is case-insensitive', async () => {
    process.env.NUXT_LOG_LEVEL = '  Error  '
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([4])
  })

  it('defaults to INFO when NODE_ENV is a non-development value (e.g. test)', async () => {
    process.env.NODE_ENV = 'test'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([1])
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

  it('honours the un-prefixed LOG_LEVEL fallback (stdio/DXT back-compat)', async () => {
    process.env.LOG_LEVEL = 'debug'
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([0]) // DEBUG from LOG_LEVEL, overriding the prod INFO default
  })

  it('prefers NUXT_LOG_LEVEL over LOG_LEVEL when both are set', async () => {
    process.env.NUXT_LOG_LEVEL = 'error'
    process.env.LOG_LEVEL = 'debug'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([4]) // ERROR (NUXT_ wins)
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
