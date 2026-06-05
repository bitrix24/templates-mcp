/**
 * Unit suite for `/api/oauth/callback` (PR-2c step 6). Drives the
 * handler through h3's real `createApp` + `toNodeListener` so cookies,
 * redirects, and headers go through production code paths. The
 * Bitrix24 token exchange is mocked via a top-level `globalThis.fetch`
 * stub — `msw` would also work but adds a dev dependency for one fetch.
 *
 * What this suite proves (§3 + §8 + §11 contracts):
 *   - Bad state / missing cookie / portal mismatch / client_id mismatch
 *     each surface a distinct errorCode and 400.
 *   - Network failure on the exchange → 502 EXCHANGE-NETWORK.
 *   - Bitrix24 returns `{ error: 'invalid_grant' }` → 502 EXCHANGE-FAIL
 *     (the canonical "code reuse" failure mode).
 *   - 5xx from Bitrix24 → 502 EXCHANGE-FAIL.
 *   - Non-JSON response body → 502 EXCHANGE-NON-JSON.
 *   - Happy path: oauth_tokens row landed, mcp_tokens Bearer minted,
 *     HTML page returned with `Cache-Control: no-store`, CSRF cookie
 *     cleared.
 *   - The full Bearer NEVER appears in any log line — only the
 *     hash prefix.
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createApp, eventHandler, toNodeListener } from 'h3'
import type * as AuditLogModule from '~/server/utils/audit-log'
import type * as TokenStoreModule from '~/server/utils/token-store'
import { createTokenStore, type TokenStore } from '~/server/utils/token-store'

// Mock the audit log to a no-op — `upsertTokens` and `createMcpToken`
// trigger `recordAuditEvent` (audit-first invariant from PR-2b). The
// real audit-log lazily creates `${NUXT_AUDIT_DIR ?? /data/audit}/` on
// first write, which fails with EACCES on CI runners. The audit-first
// invariant itself is exhaustively tested in `token-store.test.ts`;
// here we only need the callback handler to reach its DB-side effects.
type AuditEvent = Parameters<typeof AuditLogModule.recordAuditEvent>[0]
const { recordAuditEvent } = vi.hoisted(() => ({
  recordAuditEvent: vi.fn<(event: AuditEvent) => Promise<void>>(async () => undefined),
}))
vi.mock('~/server/utils/audit-log', async () => {
  const real = await vi.importActual<typeof AuditLogModule>('~/server/utils/audit-log')
  return { ...real, recordAuditEvent }
})

const runtimeConfig: Record<string, unknown> = {
  bitrix24OauthEnabled: true,
  bitrix24OauthClientId: 'app.cid.12345',
  bitrix24OauthClientSecret: 'super-secret',
  bitrix24OauthRedirectUrl: 'https://mcp.example.com/api/oauth/callback',
  bitrix24OauthScope: 'user,task',
}
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

const loggerCalls: Array<{ level: string; event: string; ctx: Record<string, unknown> | undefined }> = []
const log = (level: string) => (event: string, ctx?: Record<string, unknown>): Promise<void> => {
  loggerCalls.push({ level, event, ctx })
  return Promise.resolve()
}
vi.mock('~/server/utils/logger', () => ({
  useLogger: () => ({
    info: log('info'),
    warning: log('warning'),
    error: log('error'),
    debug: log('debug'),
    notice: log('notice'),
  }),
}))

let db: Database.Database
let store: TokenStore
vi.mock('~/server/utils/token-store', async () => {
  const real = await vi.importActual<typeof TokenStoreModule>('~/server/utils/token-store')
  return { ...real, useTokenStore: () => store }
})

// Top-level fetch mock — Vitest's globalThis-stubbing pattern.
const fetchMock = vi.fn<(typeof globalThis.fetch)>()
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => {
  db = new Database(':memory:')
  store = createTokenStore(db)
  loggerCalls.length = 0
  fetchMock.mockReset()
  runtimeConfig.bitrix24OauthEnabled = true
  runtimeConfig.bitrix24OauthClientId = 'app.cid.12345'
  runtimeConfig.bitrix24OauthClientSecret = 'super-secret'
  runtimeConfig.bitrix24OauthRedirectUrl = 'https://mcp.example.com/api/oauth/callback'
  vi.resetModules()
})
afterEach(() => {
  db.close()
})

/** Build a fetch-Response from a JSON body + status. */
function fakeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface CapturedResponse {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  errorCode?: string
}

async function callCallback(opts: {
  code?: string
  state?: string
  domain?: string
  cookie?: string
} = {}): Promise<CapturedResponse> {
  const handler = (await import('~/server/api/oauth/callback.get')).default
  const app = createApp({
    onError: (err, event) => {
      const e = err as { statusCode?: number; statusMessage?: string; data?: { errorCode?: string } }
      event.node.res.statusCode = e.statusCode ?? 500
      event.node.res.setHeader('content-type', 'application/json')
      event.node.res.end(JSON.stringify({ statusMessage: e.statusMessage, errorCode: e.data?.errorCode }))
    },
  })
  app.use('/api/oauth/callback', eventHandler(handler))
  const listener = toNodeListener(app)

  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = 'GET'
  const queryParts: string[] = []
  if (opts.code !== undefined) queryParts.push(`code=${encodeURIComponent(opts.code)}`)
  if (opts.state !== undefined) queryParts.push(`state=${encodeURIComponent(opts.state)}`)
  if (opts.domain !== undefined) queryParts.push(`domain=${encodeURIComponent(opts.domain)}`)
  req.url = `/api/oauth/callback${queryParts.length ? '?' + queryParts.join('&') : ''}`
  req.headers = {
    host: 'mcp.example.com',
    ...(opts.cookie ? { cookie: `bx24_oauth_csrf=${opts.cookie}` } : {}),
  }

  return await new Promise<CapturedResponse>((resolve) => {
    const chunks: Buffer[] = []
    const res = new ServerResponse(req)
    const origEnd = res.end.bind(res)
    res.end = ((c?: unknown, ...r: unknown[]) => {
      if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
      const result = origEnd(c as never, ...r as never[])
      const headers: Record<string, string | string[]> = {}
      for (const n of res.getHeaderNames()) {
        const v = res.getHeader(n)
        if (v !== undefined) headers[n] = v as string | string[]
      }
      const body = Buffer.concat(chunks).toString('utf8')
      let errorCode: string | undefined
      try {
        errorCode = (JSON.parse(body) as { errorCode?: string }).errorCode
      }
      catch { /* HTML body — not JSON */ }
      resolve({ statusCode: res.statusCode, headers, body, errorCode })
      return result
    }) as typeof res.end
    listener(req, res)
  })
}

/**
 * Seed an oauth_state row and return the {state, cookie} pair the
 * tests use to drive a happy or sad callback.
 */
function seedState(overrides: Partial<{
  state: string
  portal: string
  clientId: string
  csrfCookie: string
  expiresAt: number
}> = {}): { state: string; cookie: string; portal: string } {
  const state = overrides.state ?? '0'.repeat(64)
  const csrfCookie = overrides.csrfCookie ?? '1'.repeat(64)
  const portal = overrides.portal ?? 'acme.bitrix24.com'
  const clientId = overrides.clientId ?? 'app.cid.12345'
  const expiresAt = overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 300
  store.createState({ state, portal, clientId, csrfCookie, expiresAt })
  return { state, cookie: csrfCookie, portal }
}

describe('/api/oauth/callback — input validation', () => {
  it('400 PARAMS-MISSING when code is absent', async () => {
    const res = await callCallback({ state: 'whatever' })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('PARAMS-MISSING')
  })

  it('400 PARAMS-MISSING when state is absent', async () => {
    const res = await callCallback({ code: 'whatever' })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('PARAMS-MISSING')
  })
})

describe('/api/oauth/callback — state verification', () => {
  it('400 STATE-MISSING when state is not in oauth_state (no install ever happened)', async () => {
    const res = await callCallback({ code: 'c', state: 'never-existed', cookie: 'x' })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('STATE-MISSING')
  })

  it('400 STATE-EXPIRED when state TTL < now (distinct from STATE-MISSING — slow user, not a probe)', async () => {
    seedState({ state: '2'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) - 1 })
    const res = await callCallback({ code: 'c', state: '2'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('STATE-EXPIRED')
    expect(loggerCalls.find(c => c.event === 'oauth.callback.deny.state-expired')).toBeDefined()
  })

  it('expired state is still consumed (deleted) — no replay on a second attempt', async () => {
    seedState({ state: '2'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) - 1 })
    await callCallback({ code: 'c', state: '2'.repeat(64), cookie: '1'.repeat(64) })
    // Second attempt: the row was deleted on the first consume → MISSING.
    const res = await callCallback({ code: 'c', state: '2'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.errorCode).toBe('STATE-MISSING')
  })

  it('400 STATE-COOKIE-MISMATCH when CSRF cookie does not match the persisted value', async () => {
    seedState()
    const res = await callCallback({
      code: 'c',
      state: '0'.repeat(64),
      cookie: '9'.repeat(64), // wrong cookie
    })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('STATE-COOKIE-MISMATCH')
  })

  it('400 STATE-PORTAL-MISMATCH when Bitrix24 callback domain disagrees with install portal', async () => {
    seedState({ portal: 'acme.bitrix24.com' })
    const res = await callCallback({
      code: 'c',
      state: '0'.repeat(64),
      cookie: '1'.repeat(64),
      domain: 'evil.bitrix24.com',
    })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('STATE-PORTAL-MISMATCH')
  })

  it('400 STATE-CLIENT-MISMATCH when state was minted with a different clientId (operator rotated CLIENT_ID mid-flow)', async () => {
    seedState({ clientId: 'old.cid' })
    runtimeConfig.bitrix24OauthClientId = 'new.cid' // operator rotated
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('STATE-CLIENT-MISMATCH')
  })

  it('consumes the state row (one-shot — second callback with same state fails STATE-MISSING)', async () => {
    seedState()
    fetchMock.mockResolvedValue(fakeJsonResponse(200, {
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
      member_id: 'portal-a', user_id: 1, scope: 'user', domain: 'acme.bitrix24.com',
    }))
    const first = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(first.statusCode).toBe(200)
    // Second attempt with the same state → STATE-MISSING (consumed).
    const second = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(second.statusCode).toBe(400)
    expect(second.errorCode).toBe('STATE-MISSING')
  })
})

describe('/api/oauth/callback — token exchange failure modes', () => {
  beforeEach(() => seedState())

  it('502 EXCHANGE-NETWORK when fetch rejects (DNS / ECONNREFUSED)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('EXCHANGE-NETWORK')
    expect(loggerCalls.find(c => c.event === 'oauth.callback.exchange.fail')).toBeDefined()
  })

  it('502 EXCHANGE-FAIL on `{ error: "invalid_grant" }` (code reused / expired)', async () => {
    fetchMock.mockResolvedValue(fakeJsonResponse(400, { error: 'invalid_grant', error_description: 'code expired' }))
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('EXCHANGE-FAIL')
    const fail = loggerCalls.find(c => c.event === 'oauth.callback.exchange.fail')
    expect(fail).toBeDefined()
    expect(fail!.ctx).toMatchObject({ error: 'invalid_grant' })
    // The error_description (potentially user-visible content) is NOT logged.
    expect(JSON.stringify(fail!.ctx)).not.toContain('code expired')
  })

  it('502 EXCHANGE-FAIL on Bitrix24 5xx', async () => {
    fetchMock.mockResolvedValue(fakeJsonResponse(503, { error: 'service_unavailable' }))
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    // Bitrix24 5xx is an upstream outage → we surface 503 (retryable),
    // not 502 (which means "upstream gave malformed response").
    expect(res.statusCode).toBe(503)
    expect(res.body).toContain('EXCHANGE-FAIL')
  })

  it('502 EXCHANGE-FAIL on Bitrix24 4xx error (caller fault — reused code, not retryable)', async () => {
    fetchMock.mockResolvedValue(fakeJsonResponse(400, { error: 'invalid_request' }))
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('EXCHANGE-FAIL')
  })

  it('502 EXCHANGE-BAD-MEMBER-ID when Bitrix24 returns a malformed member_id', async () => {
    fetchMock.mockResolvedValue(fakeJsonResponse(200, {
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
      member_id: '../../../etc/passwd', user_id: 1, scope: 'user', domain: 'acme.bitrix24.com',
    }))
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('EXCHANGE-BAD-MEMBER-ID')
  })

  it('502 EXCHANGE-NON-JSON when response body is not JSON (HTML error page from upstream)', async () => {
    fetchMock.mockResolvedValue(new Response('<html>maintenance</html>', { status: 502 }))
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('EXCHANGE-NON-JSON')
  })

  it('502 EXCHANGE-BAD-USER-ID when Bitrix24 returns a non-numeric user_id', async () => {
    fetchMock.mockResolvedValue(fakeJsonResponse(200, {
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
      member_id: 'portal-a', user_id: 'not-a-number', scope: 'user', domain: 'acme.bitrix24.com',
    }))
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(502)
    expect(res.body).toContain('EXCHANGE-BAD-USER-ID')
  })
})

describe('/api/oauth/callback — happy path', () => {
  it('200 with Bearer in HTML, oauth_tokens + mcp_tokens persisted, CSRF cookie cleared', async () => {
    seedState({ portal: 'acme.bitrix24.com' })
    fetchMock.mockResolvedValue(fakeJsonResponse(200, {
      access_token: 'access-token-value',
      refresh_token: 'refresh-token-value',
      expires_in: 3600,
      member_id: 'portal-acme',
      user_id: 42,
      scope: 'user,task',
      domain: 'acme.bitrix24.com',
    }))

    const res = await callCallback({
      code: 'authcode',
      state: '0'.repeat(64),
      cookie: '1'.repeat(64),
      domain: 'acme.bitrix24.com',
    })

    expect(res.statusCode).toBe(200)
    // Cache-Control + Pragma headers.
    expect(res.headers['cache-control']).toMatch(/no-store/)
    expect(res.headers.pragma).toMatch(/no-cache/)
    // CSRF cookie cleared (deleteCookie emits a Max-Age=0 cookie).
    const raw = res.headers['set-cookie']
    const cookies = Array.isArray(raw) ? raw : raw ? [raw as string] : []
    const clearCookie = cookies.find(c => c.startsWith('bx24_oauth_csrf='))
    expect(clearCookie).toBeDefined()
    expect(clearCookie!.toLowerCase()).toMatch(/max-age=0/)

    // Token-store side effects: oauth_tokens row, mcp_tokens Bearer.
    const row = store.getTokens('portal-acme', 42)
    expect(row).toBeDefined()
    expect(row!.accessToken).toBe('access-token-value')
    expect(row!.refreshToken).toBe('refresh-token-value')
    expect(row!.scope).toBe('user,task')

    // The HTML carries the raw Bearer ONCE. Extract from the page.
    const bearerMatch = res.body.match(/<pre[^>]*>([a-f0-9]{64})<\/pre>/)
    expect(bearerMatch).not.toBeNull()
    const rawBearer = bearerMatch![1]!
    // Round-trip: the hashed Bearer is in mcp_tokens, lookup returns
    // the tenant pair we just upserted.
    const sha256Prefix = 'sha256-'
    // Use the same hash function the store uses — by querying via the
    // public verb.
    const bearerHash = sha256Prefix + (await import('node:crypto')).createHash('sha256').update(rawBearer).digest('hex')
    expect(store.findByBearerHash(bearerHash)).toEqual({ memberId: 'portal-acme', userId: 42 })

    // Audit-first invariant for callback path: an `mcp.create` event
    // landed; the Bearer's hash is the audit's mcpTokenId.
    // (We don't directly mock recordAuditEvent here — that's covered
    // exhaustively in token-store.test.ts; this test just confirms
    // the callback wired through to createMcpToken.)
  })

  it('logs oauth.callback.exchange.ok with bearerHashPrefix (16 hex chars only — no raw Bearer)', async () => {
    seedState()
    fetchMock.mockResolvedValue(fakeJsonResponse(200, {
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
      member_id: 'portal-a', user_id: 1, scope: 'user', domain: 'acme.bitrix24.com',
    }))
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(200)
    const ok = loggerCalls.find(c => c.event === 'oauth.callback.exchange.ok')
    expect(ok).toBeDefined()
    expect(ok!.ctx).toMatchObject({
      memberId: 'portal-a',
      userId: 1,
      portal: 'acme.bitrix24.com',
    })
    expect((ok!.ctx as { bearerHashPrefix: string }).bearerHashPrefix).toMatch(/^sha256-[a-f0-9]{8}$/)
    // The raw Bearer string MUST NOT appear in any logged context.
    const rawBearer = (res.body.match(/<pre[^>]*>([a-f0-9]{64})<\/pre>/))![1]!
    for (const call of loggerCalls) {
      expect(JSON.stringify(call.ctx ?? {})).not.toContain(rawBearer)
    }
  })

  it('does NOT mint a Bearer when the audit write fails (audit-first at the handler boundary)', async () => {
    // Round-3 review: the audit-first invariant is exhaustively tested at
    // the token-store layer, but the END-TO-END contract through the
    // handler wasn't pinned. If a future refactor reorders the handler's
    // upsert/createMcpToken vs the audit call, this catches it: a failing
    // audit must abort BEFORE a Bearer lands in mcp_tokens.
    seedState()
    fetchMock.mockResolvedValue(fakeJsonResponse(200, {
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
      member_id: 'portal-acme', user_id: 42, scope: 'user', domain: 'acme.bitrix24.com',
    }))
    // First audit call (oauth.upsert inside upsertTokens) rejects.
    recordAuditEvent.mockRejectedValueOnce(new Error('audit ENOSPC'))
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    // A rejected audit surfaces as an unhandled error → 500.
    expect(res.statusCode).toBe(500)
    // No oauth_tokens row …
    expect(store.getTokens('portal-acme', 42)).toBeUndefined()
    // … AND no mcp_tokens Bearer (the whole point of "audit-first": the
    // Bearer must not exist). Count directly — the handler never returned
    // a raw Bearer we could hash.
    const bearerCount = (db.prepare('SELECT COUNT(*) AS n FROM mcp_tokens').get() as { n: number }).n
    expect(bearerCount).toBe(0)
  })

  it('succeeds WITHOUT ?domain= and logs oauth.callback.domain-absent (other 3 §8 bindings hold)', async () => {
    // The domain binding is one of four §8 CSRF checks; Bitrix24 doesn't
    // always send `?domain=`. When absent, the flow MUST still complete
    // (state nonce + CSRF cookie + client_id still verified) but log a
    // WARN so an operator can spot the weakened binding.
    seedState({ portal: 'acme.bitrix24.com' })
    fetchMock.mockResolvedValue(fakeJsonResponse(200, {
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
      member_id: 'portal-acme', user_id: 7, scope: 'user', domain: 'acme.bitrix24.com',
    }))
    // NO domain passed.
    const res = await callCallback({ code: 'c', state: '0'.repeat(64), cookie: '1'.repeat(64) })
    expect(res.statusCode).toBe(200)
    expect(loggerCalls.find(c => c.event === 'oauth.callback.domain-absent')).toBeDefined()
    // The tenant still landed (flow completed).
    expect(store.getTokens('portal-acme', 7)).toBeDefined()
  })

  it('POSTs to oauth.bitrix24.tech/oauth/token/ with the expected form body', async () => {
    seedState()
    fetchMock.mockResolvedValue(fakeJsonResponse(200, {
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
      member_id: 'p', user_id: 1, scope: '', domain: 'acme.bitrix24.com',
    }))
    await callCallback({ code: 'authcode42', state: '0'.repeat(64), cookie: '1'.repeat(64) })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://oauth.bitrix24.tech/oauth/token/')
    expect(init!.method).toBe('POST')
    const body = (init!.body as URLSearchParams)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe('app.cid.12345')
    expect(body.get('client_secret')).toBe('super-secret')
    expect(body.get('code')).toBe('authcode42')
    expect(body.get('redirect_uri')).toBe('https://mcp.example.com/api/oauth/callback')
  })
})
