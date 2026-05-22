import type { LoggerInterface } from '@bitrix24/b24jssdk'
import { describe, expect, it, vi } from 'vitest'
import { makeRedactingLogger, redactString, redactValue } from '~/server/utils/logger-redactor'

/**
 * Unit tests for the webhook-URL redactor (issue #26, upstream tracker #38).
 * The redactor was the primary defence against SDK 1.1.1's `post/send` URL
 * leak; SDK 1.1.2 (PR `bitrix24/b24jssdk#40`) fixed the leak at source and
 * the redactor is now defence in depth. These unit tests still pin its
 * behaviour so a future bump that re-introduces a URL anywhere in the
 * logger surface is caught by the runtime regression suite
 * (`sdk-logger-leak.test.ts`) which builds on this redactor.
 *
 * Coverage:
 *  - `redactString` — direct string redaction with v2 / v3 URL shapes, multiple
 *    URLs in one string, non-URL strings (pass-through), edge cases.
 *  - `redactValue` — deep-walk over arrays + plain objects, preservation of
 *    non-plain prototypes (Error / Date), no mutation of inputs.
 *  - `makeRedactingLogger` — every `LoggerInterface` method gets wrapped;
 *    inner logger sees only redacted args.
 */

const V2_SECRET = 'sEcr3tV2Key'
const V3_SECRET = 'sEcr3tV3Key'
const V2_URL = `https://example.bitrix24.ru/rest/1/${V2_SECRET}/tasks.task.get`
const V3_URL = `https://example.bitrix24.ru/rest/api/42/${V3_SECRET}/tasks.task.list`

describe('redactString', () => {
  it('redacts the v2 webhook URL shape `/rest/<userId>/<secret>`', () => {
    const out = redactString(V2_URL)
    expect(out).not.toContain(V2_SECRET)
    expect(out).toBe('https://example.bitrix24.ru/rest/1/<REDACTED>/tasks.task.get')
  })

  it('redacts the v3 webhook URL shape `/rest/api/<userId>/<secret>`', () => {
    const out = redactString(V3_URL)
    expect(out).not.toContain(V3_SECRET)
    expect(out).toBe('https://example.bitrix24.ru/rest/api/42/<REDACTED>/tasks.task.list')
  })

  it('redacts the bare URL without a trailing method path (just the secret segment)', () => {
    const out = redactString(`https://x.bitrix24.com/rest/7/${V2_SECRET}`)
    expect(out).toBe('https://x.bitrix24.com/rest/7/<REDACTED>')
  })

  it('redacts every URL in a string with multiple webhook URLs', () => {
    const out = redactString(`first ${V2_URL} and second ${V3_URL} done`)
    expect(out).not.toContain(V2_SECRET)
    expect(out).not.toContain(V3_SECRET)
    expect(out).toContain('<REDACTED>')
    // Both URLs reduced — count `<REDACTED>` occurrences.
    expect(out.match(/<REDACTED>/g)?.length).toBe(2)
  })

  it('passes through strings that contain no webhook URL', () => {
    expect(redactString('plain message')).toBe('plain message')
    expect(redactString('')).toBe('')
    expect(redactString('value: 42, status: ok')).toBe('value: 42, status: ok')
  })

  it('passes through https URLs that are not Bitrix24 webhook-shaped', () => {
    // `/rest/` not present → not a webhook URL → no redaction.
    expect(redactString('https://example.com/api/v1/users')).toBe('https://example.com/api/v1/users')
    // `/rest/<word>/` not numeric userId → not a webhook URL → no redaction.
    // (Bitrix24 user ids are numeric. Webhook URLs always have a numeric
    // segment between `/rest/` (or `/rest/api/`) and the secret.)
    expect(redactString('https://example.com/rest/foo/bar')).toBe('https://example.com/rest/foo/bar')
  })

  it('handles secret characters at the URL boundary (no greedy over-match)', () => {
    // Secret matched only up to next `/` or whitespace / quote — trailing
    // method path preserved verbatim. Probes the matcher boundary.
    const out = redactString(`${V2_URL} other text`)
    expect(out).toContain('<REDACTED>/tasks.task.get')
    expect(out).toContain(' other text')
  })

  it('redacts URLs with http:// scheme too (not just https)', () => {
    // Bitrix24 is HTTPS in production but the matcher accepts both to avoid
    // false negatives in dev / proxy setups where the URL might be HTTP.
    const out = redactString(`http://example.bitrix24.ru/rest/1/${V2_SECRET}/x`)
    expect(out).not.toContain(V2_SECRET)
  })

  it('passes through the SDK 1.1.2 `***REDACTED***` placeholder unchanged', () => {
    // SDK 1.1.2's `redactSensitiveParams` writes `***REDACTED***` in place
    // of values under credential-bearing keys. When that pre-redacted
    // string flows through our wrapper (e.g. inside a JSON.stringify'd
    // `params:` field on `post/send`), our URL-only redactor must not
    // mangle it. Pinned so a future regex change that accidentally
    // matches the placeholder gets caught.
    expect(redactString('***REDACTED***')).toBe('***REDACTED***')
    expect(redactString('params: {"auth":"***REDACTED***","taskId":1}'))
      .toBe('params: {"auth":"***REDACTED***","taskId":1}')
  })
})

describe('redactValue', () => {
  it('redacts a string value', () => {
    expect(redactValue(V2_URL)).toBe('https://example.bitrix24.ru/rest/1/<REDACTED>/tasks.task.get')
  })

  it('walks plain object values and redacts nested strings', () => {
    const input = {
      method: V2_URL,
      requestId: 'abc-123',
      params: { url: V3_URL, count: 5 },
    }
    const out = redactValue(input) as typeof input
    expect(out.method).not.toContain(V2_SECRET)
    expect(out.params.url).not.toContain(V3_SECRET)
    expect(out.requestId).toBe('abc-123')
    expect(out.params.count).toBe(5)
  })

  it('walks arrays and redacts string elements', () => {
    const out = redactValue([V2_URL, 'plain', { url: V3_URL }]) as unknown[]
    expect(out[0]).not.toContain(V2_SECRET)
    expect(out[1]).toBe('plain')
    expect((out[2] as { url: string }).url).not.toContain(V3_SECRET)
  })

  it('handles deeply nested structures (mixed object / array / string)', () => {
    const input = { a: [{ b: [{ c: V2_URL }] }] }
    const out = redactValue(input) as { a: { b: { c: string }[] }[] }
    expect(out.a[0]!.b[0]!.c).not.toContain(V2_SECRET)
    expect(out.a[0]!.b[0]!.c).toContain('<REDACTED>')
  })

  it('passes through non-string primitives unchanged', () => {
    expect(redactValue(42)).toBe(42)
    expect(redactValue(true)).toBe(true)
    expect(redactValue(null)).toBeNull()
    expect(redactValue(undefined)).toBeUndefined()
  })

  it('does NOT walk into objects with custom prototypes (Error / Date pass through)', () => {
    // Walking into Error or Date would flatten their prototype methods into
    // plain records. We intentionally pass them through — their `message` /
    // `toString()` paths would need separate handling if they carry URLs
    // (tracked as a separate concern; AjaxError.toString() contains URL but
    // its message string is what hits the logger context, and that path is
    // covered by redactString on the string form).
    const err = new Error('boom')
    const date = new Date(2026, 0, 1)
    expect(redactValue(err)).toBe(err)
    expect(redactValue(date)).toBe(date)
  })

  it('masks values under credential-bearing keys regardless of content', () => {
    const input = {
      auth: 'tok_secret_abc',
      password: 'hunter2',
      token: '12345',
      secret: 'shhhh',
      access_token: 'bearer_xyz',
      refresh_token: 'refresh_abc',
      otherField: 'visible',
    }
    const out = redactValue(input) as typeof input
    expect(out.auth).toBe('<REDACTED>')
    expect(out.password).toBe('<REDACTED>')
    expect(out.token).toBe('<REDACTED>')
    expect(out.secret).toBe('<REDACTED>')
    expect(out.access_token).toBe('<REDACTED>')
    expect(out.refresh_token).toBe('<REDACTED>')
    expect(out.otherField).toBe('visible')
  })

  it('masks credential keys at any nesting depth', () => {
    const input = { response: { data: { access_token: 'deep_secret', id: 42 } } }
    const out = redactValue(input) as typeof input
    expect(out.response.data.access_token).toBe('<REDACTED>')
    expect(out.response.data.id).toBe(42)
  })

  it('masks credential key even when its value is a non-string (number, object)', () => {
    const input = { token: 12345, secret: { nested: 'val' } }
    const out = redactValue(input) as { token: unknown; secret: unknown }
    expect(out.token).toBe('<REDACTED>')
    expect(out.secret).toBe('<REDACTED>')
  })

  it('does NOT mutate the input object', () => {
    // The walker creates fresh objects so SDK-internal state is never altered
    // by logging. Critical for correctness: the SDK reuses its own context
    // objects across calls; mutation would propagate redaction state.
    const input = { url: V2_URL, nested: { url: V3_URL } }
    const before = JSON.stringify(input)
    redactValue(input)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('makeRedactingLogger', () => {
  function makeSpyLogger(): { logger: LoggerInterface; calls: { method: string; args: unknown[] }[] } {
    const calls: { method: string; args: unknown[] }[] = []
    const stub =
      <K extends string>(method: K) =>
      (...args: unknown[]): Promise<void> => {
        calls.push({ method, args })
        return Promise.resolve()
      }
    const logger = {
      log: stub('log'),
      debug: stub('debug'),
      info: stub('info'),
      notice: stub('notice'),
      warning: stub('warning'),
      error: stub('error'),
      critical: stub('critical'),
      alert: stub('alert'),
      emergency: stub('emergency'),
    } as unknown as LoggerInterface
    return { logger, calls }
  }

  it('redacts message + context on info()', async () => {
    const { logger, calls } = makeSpyLogger()
    const wrapped = makeRedactingLogger(logger)
    await wrapped.info(`post/send to ${V2_URL}`, { method: V2_URL, requestId: 'r1' })
    expect(calls).toHaveLength(1)
    const [msg, ctx] = calls[0]!.args as [string, Record<string, unknown>]
    expect(msg).not.toContain(V2_SECRET)
    expect(ctx.method).not.toContain(V2_SECRET)
    expect(ctx.requestId).toBe('r1')
  })

  it('redacts on every LoggerInterface level method (debug / notice / warning / error / critical / alert / emergency)', async () => {
    const { logger, calls } = makeSpyLogger()
    const wrapped = makeRedactingLogger(logger)
    await wrapped.debug(V2_URL)
    await wrapped.notice(V2_URL)
    await wrapped.warning(V2_URL)
    await wrapped.error(V2_URL)
    await wrapped.critical(V2_URL)
    await wrapped.alert(V2_URL)
    await wrapped.emergency(V2_URL)
    expect(calls).toHaveLength(7)
    for (const call of calls) {
      const [msg] = call.args as [string]
      expect(msg, `level ${call.method} did not redact`).not.toContain(V2_SECRET)
    }
  })

  it('redacts via the generic log(level, message, context) entry point', async () => {
    // `log(level, msg, ctx)` is the LoggerInterface "arbitrary level" entry —
    // current SDK callsites use the level-named methods, but we wrap it for
    // completeness so a future SDK callsite via
    // `getLogger().log(LogLevel.INFO, url, {})` is also covered.
    const inner = { log: vi.fn().mockResolvedValue(undefined) } as unknown as LoggerInterface
    Object.assign(inner, {
      debug: vi.fn(),
      info: vi.fn(),
      notice: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
      critical: vi.fn(),
      alert: vi.fn(),
      emergency: vi.fn(),
    })
    const wrapped = makeRedactingLogger(inner)
    await wrapped.log(200 as never, V2_URL, { method: V2_URL })
    expect(inner.log).toHaveBeenCalledTimes(1)
    const [, msg, ctx] = (inner.log as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(msg).not.toContain(V2_SECRET)
    expect((ctx as { method: string }).method).not.toContain(V2_SECRET)
  })

  it('passes through undefined context (does not crash on `info("msg")` with no second arg)', async () => {
    const { logger, calls } = makeSpyLogger()
    const wrapped = makeRedactingLogger(logger)
    await wrapped.info('plain')
    expect(calls[0]!.args[1]).toBeUndefined()
  })

  it('returns a Promise from each method (preserves the LoggerInterface contract)', () => {
    const { logger } = makeSpyLogger()
    const wrapped = makeRedactingLogger(logger)
    expect(wrapped.info('x')).toBeInstanceOf(Promise)
    expect(wrapped.error('x')).toBeInstanceOf(Promise)
  })
})
