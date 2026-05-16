import { Logger, ConsoleHandler, LogLevel } from '@bitrix24/b24jssdk'

/**
 * Process-singleton structured logger built from the Bitrix24 SDK's own
 * Logger system.
 *
 * Why the SDK logger and not consola / pino: `B24Hook.setLogger(logger)`
 * accepts the SDK's `LoggerInterface`, so the SDK's own retry, rate-limit,
 * 503-adaptive-delay, and request-error events flow into the same channel
 * as application logs. One sink, no double bookkeeping.
 *
 * Handler stack:
 *   - ConsoleHandler at INFO in production (NUXT_ENV !== 'development'),
 *     DEBUG in development. Coloured output where the terminal supports it.
 *
 * To plug in more handlers (file rotation, telegram, etc.), call
 * `logger.pushHandler(new StreamHandler({...}))` etc. once at startup.
 */
let loggerInstance: Logger | null = null

export function useLogger(): Logger {
  if (loggerInstance) return loggerInstance

  const isDev = process.env.NODE_ENV === 'development'
  const level = isDev ? LogLevel.DEBUG : LogLevel.INFO

  loggerInstance = Logger.create('bx24-template-mcp')
  loggerInstance.pushHandler(new ConsoleHandler(level))

  return loggerInstance
}
