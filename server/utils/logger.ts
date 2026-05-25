import { ConsoleHandler, Logger, LogLevel, type LoggerInterface } from '@bitrix24/b24jssdk'
import { redactString } from './logger-redactor'

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
 *   - `ConsoleHandler` at the level named by `NUXT_LOG_LEVEL`
 *     (`debug` / `info` / `notice` / `warning` / `error` / `critical` /
 *     `alert` / `emergency`, case-insensitive; `warn` is accepted as an
 *     alias for `warning`). When unset or unrecognised it falls back to
 *     `DEBUG` in development and `INFO` otherwise. Coloured output where the
 *     terminal supports it.
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

const LEVEL_BY_NAME: Record<string, LogLevel> = {
  DEBUG: LogLevel.DEBUG,
  INFO: LogLevel.INFO,
  NOTICE: LogLevel.NOTICE,
  WARN: LogLevel.WARNING,
  WARNING: LogLevel.WARNING,
  ERROR: LogLevel.ERROR,
  CRITICAL: LogLevel.CRITICAL,
  ALERT: LogLevel.ALERT,
  EMERGENCY: LogLevel.EMERGENCY,
}

/**
 * Resolves the console log level. Read from the environment directly (not via
 * `useRuntimeConfig()`) so the level is available even when the singleton
 * materialises before the Nitro app context — the same reason `audit-log.ts`
 * reads its env directly. The env chain mirrors the stdio shim
 * (`mcp-stdio/nuxt-shims.ts`): `NUXT_LOG_LEVEL` is canonical (the DXT manifest
 * injects it from `user_config.log_level`), `LOG_LEVEL` is the un-prefixed
 * back-compat fallback for older bundles / the README dry-run. An explicit,
 * recognised value always wins; otherwise we keep the historical default
 * (`DEBUG` in development, `INFO` elsewhere).
 *
 * If either env var is set to a NON-EMPTY but UNRECOGNISED value (a typo like
 * `debgu`), emit a one-shot warning to **stderr** naming the bad value, the
 * variable it came from, the active `NODE_ENV`, and the level actually used.
 * Stderr (never stdout) because the stdio transport reserves stdout for
 * JSON-RPC frames — a console.log here would corrupt the protocol stream.
 * Fires once because `useLogger()` is a process-singleton (the resolver is
 * called once at materialisation). Empty / whitespace-only values stay silent
 * — those are common in `.env` templates and aren't worth a warning.
 *
 * The echoed value is **capped at 32 chars and run through `redactString`**
 * before leaving the process: an operator who accidentally puts a webhook URL
 * or long token into `NUXT_LOG_LEVEL` (variable-name mix-up) gets a
 * truncated, redacted echo instead of a full secret leaking into
 * `journalctl` / `docker logs` / Claude Desktop's extension log. 32 chars
 * fits every legitimate level name with room for diagnostic context.
 *
 * @see https://github.com/bitrix24/templates-mcp/issues/137
 */
function resolveLevel(): LogLevel {
  const [rawValue, varName]
    = process.env.NUXT_LOG_LEVEL !== undefined
      ? [process.env.NUXT_LOG_LEVEL, 'NUXT_LOG_LEVEL']
      : process.env.LOG_LEVEL !== undefined
        ? [process.env.LOG_LEVEL, 'LOG_LEVEL']
        : ['', null] as const
  const configured = rawValue.trim().toUpperCase()
  if (configured && configured in LEVEL_BY_NAME) return LEVEL_BY_NAME[configured]!

  const fallback = process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO
  if (configured && varName) {
    // Explicit display map — the fallback is always DEBUG or INFO by the
    // branch above, but spelling it out (vs reverse-walking `LEVEL_BY_NAME`)
    // sidesteps the `WARN`/`WARNING` alias collision and survives any SDK
    // enum renumbering.
    const fallbackName = fallback === LogLevel.DEBUG ? 'DEBUG' : fallback === LogLevel.INFO ? 'INFO' : String(fallback)
    const safeValue = redactString(rawValue.slice(0, 32)) + (rawValue.length > 32 ? '…' : '')
    const nodeEnv = process.env.NODE_ENV ?? 'unset'
    // Approved exception to the "one sink" rule (see top-of-file JSDoc): the
    // SDK Logger isn't materialised yet (we're resolving its own level), and
    // stdout is reserved for JSON-RPC frames in stdio mode. Direct stderr is
    // the only safe channel for this one-shot startup diagnostic.
    process.stderr.write(
      `[bx24-template-mcp] ${varName}=${JSON.stringify(safeValue)} not recognised; `
      + `using ${fallbackName} (NODE_ENV=${nodeEnv}). `
      + `Valid: debug, info, notice, warning (alias warn), error, critical, alert, emergency.\n`,
    )
  }
  return fallback
}

export function useLogger(): LoggerInterface {
  if (loggerInstance) return loggerInstance

  loggerInstance = Logger.create('bx24-template-mcp')
  loggerInstance.pushHandler(new ConsoleHandler(resolveLevel()))

  return loggerInstance
}
