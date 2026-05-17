import type { LoggerInterface, LogLevel } from '@bitrix24/b24jssdk'

/**
 * Defence against the Bitrix24 SDK leaking the webhook secret into log
 * sinks (issue #26).
 *
 * Background — the SDK's HTTP layer (`core/http/abstract-http.mjs`) logs
 * the full request URL on every call:
 *
 *   this.getLogger().info('post/send', { requestId, method: methodFormatted, params })
 *
 * where `methodFormatted = baseUrl + /<method>` and `baseUrl` is the full
 * webhook URL including the user id and SECRET path segments:
 *
 *   https://<portal>.bitrix24.<tld>/rest/<userId>/<SECRET>          (v2)
 *   https://<portal>.bitrix24.<tld>/rest/api/<userId>/<SECRET>      (v3)
 *
 * Without redaction, every Bitrix24 API call writes the secret to every
 * destination our logger ships to (stdout, file, log aggregator). For a
 * single-tenant self-hosted MCP the blast radius is "every operator with
 * log access"; for a hosted multi-tenant MCP this would be a credential
 * disclosure.
 *
 * The redactor wraps our `useLogger()` instance with one that scrubs
 * URL-shaped values out of every log message and context object BEFORE
 * the inner logger sees them. Wired up in `server/utils/bitrix24.ts`
 * before `client.setLogger(...)`.
 *
 * Upstream tracking: Bitrix24 should redact at SDK level — once they
 * ship that fix, this wrapper becomes belt-and-suspenders, not the
 * primary defence. We keep it anyway: redundant credential protection
 * is cheap, and we don't trust SDK release notes to call out logger
 * surface regressions in future bumps.
 */

/**
 * Matches Bitrix24 webhook URLs in their two documented shapes:
 *
 *   v2: https://<host>/rest/<userId>/<secret>[/<method-or-anything>]
 *   v3: https://<host>/rest/api/<userId>/<secret>[/<method-or-anything>]
 *
 * Capture groups:
 *   1. URL prefix up to and including the `<userId>/` — safe to keep
 *      (operator can correlate by portal + user without seeing the
 *      secret).
 *   2. The SECRET segment — replaced with `<REDACTED>`.
 *
 * The matcher is intentionally greedy on the prefix ("rest" path with
 * optional "api" sub-segment) to handle both API versions in one rule,
 * and stops the secret capture at the next `/` or whitespace / quote
 * boundary so trailing method names in the URL (e.g. `/tasks.task.get`)
 * are preserved for debugging.
 */
const WEBHOOK_URL_RE = /(https?:\/\/[^/\s"'<>]+\/rest\/(?:api\/)?\d+\/)([A-Za-z0-9_-]+)/g

/** Redact webhook secrets out of any string. Non-URL strings pass through. */
export function redactString(input: string): string {
  return input.replace(WEBHOOK_URL_RE, '$1<REDACTED>')
}

/**
 * Deep-walk a context value and redact every string it contains. Arrays,
 * plain objects, and nested combinations are handled. Non-string primitives
 * (number, boolean, null, undefined) pass through unchanged. Objects with
 * custom prototypes (Error, Date, etc.) are returned as-is — we don't want
 * to flatten them into plain records, and our redaction only targets
 * URL-shaped strings which live in plain-data positions in SDK log
 * contexts.
 *
 * The walker creates fresh objects/arrays — it does NOT mutate the input.
 * This matters because the SDK passes its own internal objects into the
 * logger; mutating them would corrupt SDK state.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v)
    return out
  }
  return value
}

function redactContext(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context) return context
  return redactValue(context) as Record<string, unknown>
}

/**
 * Wrap an inner logger so that every `LoggerInterface` method scrubs
 * webhook URLs from the `message` and `context` arguments before passing
 * them through. The inner logger sees only redacted data; nothing else
 * about its behaviour changes.
 *
 * The `log(level, message, context)` variant exists because the SDK's
 * `LoggerInterface` includes it as the "log with arbitrary level" entry
 * point — covered here for completeness even though SDK 1.1.1's own
 * callsites use the level-named methods (`debug`/`info`/`warning`/`error`).
 */
export function makeRedactingLogger(inner: LoggerInterface): LoggerInterface {
  const wrapLevel = <K extends keyof Pick<LoggerInterface, 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'>>(
    level: K,
  ) => {
    return (message: string, context?: Record<string, unknown>): Promise<void> => {
      return inner[level](redactString(message), redactContext(context))
    }
  }
  return {
    log: (level: LogLevel, message: string, context?: Record<string, unknown>) =>
      inner.log(level, redactString(message), redactContext(context)),
    debug: wrapLevel('debug'),
    info: wrapLevel('info'),
    notice: wrapLevel('notice'),
    warning: wrapLevel('warning'),
    error: wrapLevel('error'),
    critical: wrapLevel('critical'),
    alert: wrapLevel('alert'),
    emergency: wrapLevel('emergency'),
  }
}
