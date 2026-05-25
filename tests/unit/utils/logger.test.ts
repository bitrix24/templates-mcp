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
let stderrSpy: ReturnType<typeof vi.spyOn>

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
    // Capture the unrecognised-level warning so test output stays clean AND
    // tests can assert call counts. The handler returns true to match the
    // real `process.stderr.write` signature. The spy MUST be installed before
    // `loadFresh()` — `resolveLevel()` runs inside the first `useLogger()`
    // call (which lives in the module top-level path) and writes immediately,
    // so a late spy would miss it.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    stderrSpy.mockRestore()
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

  // The text-content assertions below pin the format produced by
  // `resolveLevel()` in `server/utils/logger.ts`. If the warning string
  // changes there, update these `toContain(...)` expectations to match.
  it('falls back to the NODE_ENV default on an unrecognised level (and warns once)', async () => {
    process.env.NUXT_LOG_LEVEL = 'verbose'
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([1])

    // The warning is observable, not silent — see #137. Pin the contract:
    // var name, bad value, NODE_ENV, and effective fallback level all appear
    // in the single stderr line, terminated by a newline.
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const msg = String(stderrSpy.mock.calls[0]![0])
    expect(msg).toContain('NUXT_LOG_LEVEL')
    expect(msg).toContain('verbose')
    expect(msg).toContain('INFO')
    expect(msg).toContain('NODE_ENV=production')
    expect(msg.endsWith('\n')).toBe(true)
  })

  it('warns about an unrecognised NUXT_LOG_LEVEL in dev (fallback DEBUG, names dev)', async () => {
    process.env.NUXT_LOG_LEVEL = 'verbsoe'
    process.env.NODE_ENV = 'development'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([0]) // dev DEBUG fallback

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const msg = String(stderrSpy.mock.calls[0]![0])
    expect(msg).toContain('NUXT_LOG_LEVEL')
    expect(msg).toContain('verbsoe')
    expect(msg).toContain('DEBUG')
    expect(msg).toContain('NODE_ENV=development')
  })

  it('warns about an unrecognised LOG_LEVEL fallback (names LOG_LEVEL, not NUXT_LOG_LEVEL)', async () => {
    process.env.LOG_LEVEL = 'debgu'
    process.env.NODE_ENV = 'development'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([0]) // dev DEBUG fallback

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const msg = String(stderrSpy.mock.calls[0]![0])
    expect(msg).toContain('LOG_LEVEL=')
    expect(msg).not.toContain('NUXT_LOG_LEVEL')
    expect(msg).toContain('debgu')
    expect(msg).toContain('DEBUG')
  })

  it('reports NODE_ENV=unset when the variable is not in the environment', async () => {
    process.env.NUXT_LOG_LEVEL = 'infoo'
    // NODE_ENV intentionally not set — beforeEach already deleted it.
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([1]) // non-dev → INFO

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(String(stderrSpy.mock.calls[0]![0])).toContain('NODE_ENV=unset')
  })

  it('does not warn on recognised values (incl. the warn alias and padding)', async () => {
    process.env.NUXT_LOG_LEVEL = '  Warn  '
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([3])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('does not warn when neither env var is set (default path)', async () => {
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([1])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('does not warn for an empty string value (operator clearing the .env line)', async () => {
    // `NUXT_LOG_LEVEL=` produces `process.env.NUXT_LOG_LEVEL === ''` — set
    // but blank. Different code path from "whitespace-only" below; both must
    // stay silent.
    process.env.NUXT_LOG_LEVEL = ''
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([1])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('does not warn for a whitespace-only value (common .env template case)', async () => {
    process.env.NUXT_LOG_LEVEL = '   '
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    useLogger()
    expect(handlerLevels).toEqual([1])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('warns exactly once even across repeat useLogger() calls (singleton init)', async () => {
    process.env.NUXT_LOG_LEVEL = 'infoo'
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    useLogger()
    useLogger()
    useLogger()
    expect(stderrSpy).toHaveBeenCalledTimes(1)
  })

  it('caps and redacts the echoed value (no secret leak via NUXT_LOG_LEVEL mix-up)', async () => {
    // If an operator accidentally puts a webhook URL or long token into
    // NUXT_LOG_LEVEL (variable-name mix-up), the warning must not echo it
    // verbatim into journald / docker logs. Test both cap (32 chars) AND
    // redaction (webhook secret).
    process.env.NUXT_LOG_LEVEL = 'https://portal.bitrix24.ru/rest/1/abcdef1234567890secret/'
    process.env.NODE_ENV = 'production'
    const { useLogger } = await loadFresh()
    useLogger()

    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const msg = String(stderrSpy.mock.calls[0]![0])
    // Webhook secret never appears, even truncated.
    expect(msg).not.toContain('abcdef1234567890secret')
    // Truncation marker is present (the raw value is longer than 32 chars).
    expect(msg).toContain('…')
    // Sanity: still warns about the right variable.
    expect(msg).toContain('NUXT_LOG_LEVEL')
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
