import { ConsoleHandler, Logger, LogLevel, type LoggerInterface } from '@bitrix24/b24jssdk'

/**
 * Process-singleton structured logger built from the Bitrix24 SDK's own
 * `Logger` system.
 *
 * Why the SDK logger and not consola / pino: `B24Hook.setLogger(logger)`
 * accepts the SDK's `LoggerInterface`, so the SDK's own retry, rate-limit,
 * 503-adaptive-delay, and request-error events flow into the same channel
 * as application logs. One sink, no double bookkeeping.
 *
 * Handler stack:
 *   - `ConsoleHandler` at `INFO` when `NODE_ENV !== 'development'`,
 *     `DEBUG` in development. Coloured output where the terminal supports it.
 *
 * Return type is `LoggerInterface` (not the concrete `Logger`) so callers
 * stay decoupled from the SDK class. If we ever swap loggers (pino, custom
 * adapter, …), tool code reading `useLogger().info(…)` keeps working. The
 * concrete `Logger` is still used internally to call `pushHandler` at
 * bootstrap.
 *
 * **Init order matters.** The level is locked when the first `useLogger()`
 * call materialises the singleton — typically the first `useBitrix24()`
 * invocation. Make sure `NODE_ENV` is set BEFORE that (Nuxt / Nitro do this
 * during boot, before any handler runs, so the default flow is correct).
 * Custom server entry points that defer env loading would need to call
 * `useLogger()` after their config is ready.
 *
 * To plug in more handlers (file rotation, telegram, etc.), call
 * `pushHandler(new StreamHandler({…}))` etc. once at startup before the
 * first `useLogger()` invocation, or cast to `Logger` if you need to do it
 * lazily.
 */
let loggerInstance: Logger | null = null

export function useLogger(): LoggerInterface {
  if (loggerInstance) return loggerInstance

  const isDev = process.env.NODE_ENV === 'development'
  const level = isDev ? LogLevel.DEBUG : LogLevel.INFO

  loggerInstance = Logger.create('bx24-template-mcp')
  loggerInstance.pushHandler(new ConsoleHandler(level))

  return loggerInstance
}
