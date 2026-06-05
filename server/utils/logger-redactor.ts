import type { LoggerInterface, LogLevel } from '@bitrix24/b24jssdk'

/**
 * Defence-in-depth against the Bitrix24 SDK leaking the webhook secret
 * into log sinks (issue #26, upstream tracker #38 / `bitrix24/b24jssdk` #39).
 *
 * History — SDK 1.1.1's HTTP layer (`core/http/abstract-http.mjs`) logged
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
 * SDK 1.1.2 (PR bitrix24/b24jssdk#40) fixed it: the `post/send` callsite
 * now logs the bare REST method name (e.g. `tasks.task.get`) instead of
 * the formatted URL, and the SDK also redacts a handful of credential-
 * bearing param keys (`auth`, `password`, `token`, `secret`,
 * `access_token`, `refresh_token`) via its own `redactSensitiveParams`.
 *
 * This wrapper is no longer the primary defence — SDK ≥1.1.2 is — but it
 * stays wired in `server/utils/bitrix24.ts` as defence in depth. It scrubs
 * URL-shaped values out of every log message + context object BEFORE the
 * inner logger sees them, so any future SDK regression that re-introduces
 * a URL anywhere in the logger surface is still caught. Redundant
 * credential protection is cheap; SDK release notes don't always call out
 * logger-surface regressions on every bump.
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

/**
 * OAuth-flow secrets in URL query-string position. Catches the four
 * parameters that carry credential material across the install/callback/
 * refresh surface (`docs/OAUTH-DESIGN.md §11`):
 *
 *   - `?code=…`           — install-time authorization code
 *   - `?refresh_token=…`  — long-lived refresh token (rotation surface)
 *   - `?access_token=…`   — short-lived bearer (defence-in-depth)
 *   - `?client_secret=…`  — should never appear in URLs but matched for
 *                            the case where a misconfigured SDK puts it
 *                            in a body that gets stringified into a URL
 *
 * Capture groups:
 *   1. The `?key=` or `&key=` separator + parameter name (preserved).
 *   2. The parameter value up to the next `&`, whitespace, or quote.
 *      Replaced with `<REDACTED>` so an operator reading the log can
 *      still see WHICH parameter was present, just not its value.
 *
 * This regex covers fixture shapes 1, 2, and 3 from §11 (object field
 * `{url}`, object field `{redirectUrl}`, template-literal carrying an
 * URL via `err.message`) — anywhere the URL ends up as a string, the
 * redactor walks it. Fixture shape 4 (JSON-stringified response body)
 * is covered by {@link OAUTH_JSON_RE} below.
 */
const OAUTH_URL_RE = /([?&](?:code|refresh_token|access_token|client_secret)=)([^&\s"'<>]+)/g

/**
 * OAuth secrets in JSON-literal position. Catches the case where a
 * response body or request payload is serialised via `JSON.stringify(...)`
 * and the resulting string lands in a log context (fixture shape 4 in
 * §11). Without this regex, `logger.error('exchange failed', { body:
 * JSON.stringify(res) })` would leak the raw `access_token` / `refresh_token`
 * values verbatim because the SENSITIVE_KEYS walker only fires on direct
 * object keys, not on substrings inside an already-serialised payload.
 *
 *   `"access_token":"abc123"` → `"access_token":"<REDACTED>"`
 *   `"refresh_token":"def456"` → `"refresh_token":"<REDACTED>"`
 *   `"client_secret":"…"` → `"client_secret":"<REDACTED>"`
 *
 * The `code` parameter is intentionally OMITTED from this regex —
 * `"code"` is a common JSON key name (HTTP status codes, error codes,
 * etc.) and matching it here would over-redact. The URL-shaped `?code=`
 * is the only realistic leak surface for an authorization code.
 *
 * Capture groups:
 *   1. The opening `"key":"` (preserved so the key name stays visible).
 *   2. The value up to the next `"` — replaced with `<REDACTED>`.
 *
 * Value class is `[^"]+` (everything up to the closing quote), NOT
 * `[^"\\]+`. OAuth tokens are opaque hex / base64url and never contain
 * a literal `"`, so stopping at the first quote always captures the
 * whole value. An earlier `[^"\\]+` would have stopped at a stray
 * backslash mid-token and leaked the tail (`<REDACTED>abc` instead of
 * `<REDACTED>`).
 */
const OAUTH_JSON_RE = /("(?:access_token|refresh_token|client_secret)"\s*:\s*")([^"]+)/g

/**
 * Credential-bearing key names whose values should be masked regardless of
 * content. Mirrors the SDK's own `redactSensitiveParams` list so that any
 * response-body fields the SDK does not yet cover are still caught here.
 *
 * `client_secret` is added on top of the SDK's list — the SDK has no
 * concept of OAuth client secrets, but our install/callback surface
 * (PR-2c) can pass them through a structured logger context.
 */
const SENSITIVE_KEYS = new Set(['auth', 'password', 'token', 'secret', 'access_token', 'refresh_token', 'client_secret'])

/** Redact webhook secrets AND OAuth secrets out of any string. Non-matching strings pass through. */
export function redactString(input: string): string {
  return input
    .replace(WEBHOOK_URL_RE, '$1<REDACTED>')
    .replace(OAUTH_URL_RE, '$1<REDACTED>')
    .replace(OAUTH_JSON_RE, '$1<REDACTED>')
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
  return redactValueWithKey(value)
}

function redactValueWithKey(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEYS.has(key)) return '<REDACTED>'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map(v => redactValueWithKey(v))
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactValueWithKey(v, k)
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
 * point — covered here for completeness even though current SDK
 * callsites use the level-named methods (`debug`/`info`/`warning`/`error`).
 *
 * Note on typing: the SDK's `LoggerInterface` declares `context?:
 * Record<string, any>`. We narrow to `Record<string, unknown>` here to
 * satisfy this project's `no-explicit-any` lint rule and to keep the
 * walker's input statically opaque. `unknown` is structurally a subset
 * of `any` so passing our wrapper into anything expecting the SDK's
 * `LoggerInterface` is variance-safe.
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
