import type { LoggerInterface } from '@bitrix24/b24jssdk'
import { describe, expect, it } from 'vitest'
import { makeRedactingLogger, redactString, redactValue } from '~/server/utils/logger-redactor'

/**
 * OAuth-surface redactor invariants (PR-2c, design in `docs/OAUTH-DESIGN.md
 * §11`). The webhook-only invariants live in `logger-redactor.test.ts`; this
 * file pins the four log-shape fixtures §11 nails down as a precondition
 * for any OAuth handler that emits a structured log line.
 *
 * The four fixture shapes:
 *   1. `{ url: '…?code=…' }`           — structured field named `url`.
 *   2. `{ redirectUrl: '…?refresh_token=…' }` — same shape, different name.
 *   3. `` `… ${err.message}` ``        — template literal carrying a URL
 *      (e.g. `node-fetch` puts the URL inside `err.message`).
 *   4. `{ body: JSON.stringify(response) }` — response-body field carrying
 *      JSON-serialised `access_token` / `refresh_token` etc.
 *
 * Lint cannot catch shapes 3 and 4 by AST alone — they rely entirely on the
 * runtime redactor. These tests are mandatory before any OAuth handler
 * ships (per §11 commit-ordering invariant: redactor + tests FIRST, callers
 * second).
 */

const CODE = 'AUTHCODE_abc123def456ghi789jkl0'
const REFRESH = 'REFRESHTOKEN_zxy987wvu654tsr321qpo'
const ACCESS = 'ACCESSTOKEN_mno456pqr789stu012'
const CLIENT_SECRET = 'CLIENTSECRET_aaa111bbb222ccc333'
const INSTALL_URL = `https://example.bitrix24.ru/oauth/authorize/?client_id=app.cid&state=s&redirect_uri=https%3A%2F%2Fmcp.example.com%2Fapi%2Foauth%2Fcallback&code=${CODE}`
const REFRESH_URL = `https://oauth.bitrix24.tech/oauth/token/?grant_type=refresh_token&refresh_token=${REFRESH}&client_id=app.cid&client_secret=${CLIENT_SECRET}`

describe('redactString — OAuth URL params (fixture shapes 1, 2, 3)', () => {
  it('shape 1: redacts ?code= in a `url` field value', () => {
    // The most common shape: `logger.info('oauth.callback.start', { url })`.
    // The `url` here flows through redactValue → redactString.
    const out = redactString(INSTALL_URL)
    expect(out).not.toContain(CODE)
    expect(out).toContain('code=<REDACTED>')
    // Other query params stay visible (operator forensics).
    expect(out).toContain('client_id=app.cid')
    expect(out).toContain('state=s')
  })

  it('shape 2: redacts ?refresh_token= in a `redirectUrl`-style field', () => {
    const out = redactString(REFRESH_URL)
    expect(out).not.toContain(REFRESH)
    expect(out).not.toContain(CLIENT_SECRET)
    expect(out).toContain('refresh_token=<REDACTED>')
    expect(out).toContain('client_secret=<REDACTED>')
    expect(out).toContain('grant_type=refresh_token')
  })

  it('shape 3: redacts URL substrings inside a template-literal message (err.message etc.)', () => {
    // `node-fetch` and friends embed the URL in `err.message`. Logger
    // callsites that pass the WHOLE message — `logger.error(`exchange
    // failed: ${err.message}`)` — must still scrub.
    const errMessage = `request to ${REFRESH_URL} failed, reason: connect ECONNREFUSED`
    const composed = `oauth.callback.exchange.fail: ${errMessage}`
    const out = redactString(composed)
    expect(out).not.toContain(REFRESH)
    expect(out).not.toContain(CLIENT_SECRET)
    expect(out).toContain('<REDACTED>')
    expect(out).toContain('ECONNREFUSED') // surrounding context preserved
  })

  it('redacts ?access_token= when it slips into a URL (defence-in-depth)', () => {
    // Production code shouldn't pass access_token via URL, but a misuse of
    // `URL.searchParams.set('access_token', …)` would land it there. The
    // redactor catches that without burdening the handler with manual
    // filtering.
    const stray = `https://api.example.com/?access_token=${ACCESS}`
    const out = redactString(stray)
    expect(out).not.toContain(ACCESS)
    expect(out).toContain('access_token=<REDACTED>')
  })

  it('redacts every OAuth secret in a multi-param URL — no half-redaction', () => {
    const all = `${INSTALL_URL}&access_token=${ACCESS}`
    const out = redactString(all)
    expect(out).not.toContain(CODE)
    expect(out).not.toContain(ACCESS)
    const matches = out.match(/<REDACTED>/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

describe('redactString — OAuth JSON-literal tokens (fixture shape 4)', () => {
  it('redacts "access_token":"…" inside a JSON-stringified body', () => {
    // The shape that the SDK / fetch response lands as when a handler does
    // `logger.error('oauth.callback.exchange.fail', { body: JSON.stringify(res) })`.
    // §11 explicitly calls this out as a fixture the redactor MUST handle.
    const body = JSON.stringify({
      access_token: ACCESS,
      refresh_token: REFRESH,
      expires_in: 3600,
      scope: 'user,task',
    })
    const out = redactString(body)
    expect(out).not.toContain(ACCESS)
    expect(out).not.toContain(REFRESH)
    expect(out).toContain('"access_token":"<REDACTED>"')
    expect(out).toContain('"refresh_token":"<REDACTED>"')
    // Non-sensitive fields visible.
    expect(out).toContain('"expires_in":3600')
    expect(out).toContain('"scope":"user,task"')
  })

  it('fully redacts a token value containing a backslash (no leaked tail)', () => {
    // Round-3: the earlier `[^"\\]+` value class stopped at a stray `\`
    // and leaked the tail (`<REDACTED>tail`). `[^"]+` captures the whole
    // opaque value up to the closing quote.
    const weird = 'abc\\def\\ghi'
    const out = redactString(`{"access_token":"${weird}"}`)
    expect(out).not.toContain('def')
    expect(out).not.toContain('ghi')
    expect(out).toBe('{"access_token":"<REDACTED>"}')
  })

  it('redacts "client_secret":"…" in a JSON-stringified payload', () => {
    const body = JSON.stringify({ client_id: 'app.cid', client_secret: CLIENT_SECRET, grant_type: 'authorization_code' })
    const out = redactString(body)
    expect(out).not.toContain(CLIENT_SECRET)
    expect(out).toContain('"client_secret":"<REDACTED>"')
    expect(out).toContain('"client_id":"app.cid"')
  })

  it('tolerates whitespace between key and value (pretty-printed JSON)', () => {
    // JSON.stringify with indentation puts a space after the `:` — the
    // regex must accept that too, otherwise the redactor would silently
    // miss pretty-printed payloads (which are exactly what an operator
    // would inspect by hand).
    const body = JSON.stringify({ access_token: ACCESS }, null, 2)
    expect(body).toContain('"access_token": "') // sanity: there IS a space
    const out = redactString(body)
    expect(out).not.toContain(ACCESS)
    expect(out).toContain('<REDACTED>')
  })

  it('does NOT over-redact a generic "code" JSON field (HTTP status, error code, etc.)', () => {
    // `code` is too common a key name in JSON to safely match. The OAuth
    // authorization code only realistically leaks via the `?code=` URL
    // shape, which IS covered. JSON-shape `{"code": …}` is left alone so
    // we don't redact HTTP status codes, Bitrix24 error codes
    // (QUERY_LIMIT_EXCEEDED, ACCESS_DENIED), etc.
    const body = JSON.stringify({ code: 'ACCESS_DENIED', message: 'forbidden' })
    const out = redactString(body)
    expect(out).toBe(body) // unchanged
  })
})

describe('redactValue — SENSITIVE_KEYS includes client_secret', () => {
  it('masks direct `client_secret` field on an object (key-based redaction)', () => {
    // The object-walker path: `logger.error('oauth.callback.exchange.fail',
    // { client_id, client_secret })`. Distinct from the JSON-literal shape
    // above — this is a structured field, key-matched.
    const out = redactValue({ client_id: 'app.cid', client_secret: CLIENT_SECRET }) as { client_id: string; client_secret: string }
    expect(out.client_id).toBe('app.cid')
    expect(out.client_secret).toBe('<REDACTED>')
  })
})

describe('makeRedactingLogger — OAuth fixtures pass through wrapped logger', () => {
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

  it('end-to-end: an OAuth callback log line with {url, body} loses both secrets', async () => {
    // Composite of fixture shapes 1 and 4 — the realistic shape PR-2c's
    // callback handler would emit on the failure path.
    const { logger, calls } = makeSpyLogger()
    const wrapped = makeRedactingLogger(logger)
    await wrapped.error('oauth.callback.exchange.fail', {
      requestId: 'a1b2c3',
      url: INSTALL_URL,
      body: JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH }),
    })
    expect(calls).toHaveLength(1)
    const [msg, ctx] = calls[0]!.args as [string, Record<string, unknown>]
    expect(msg).toBe('oauth.callback.exchange.fail')
    expect(ctx.url).not.toContain(CODE)
    expect(ctx.body).not.toContain(ACCESS)
    expect(ctx.body).not.toContain(REFRESH)
    // Operator-visible context preserved.
    expect(ctx.requestId).toBe('a1b2c3')
  })

  it('end-to-end: template-literal message carrying err.message — both message and context scrubbed', async () => {
    const { logger, calls } = makeSpyLogger()
    const wrapped = makeRedactingLogger(logger)
    const errMessage = `failed POST to ${REFRESH_URL}`
    await wrapped.error(`oauth.refresh.fail: ${errMessage}`, { requestId: 'b2c3d4' })
    const [msg] = calls[0]!.args as [string]
    expect(msg).not.toContain(REFRESH)
    expect(msg).not.toContain(CLIENT_SECRET)
    expect(msg).toContain('<REDACTED>')
  })
})
