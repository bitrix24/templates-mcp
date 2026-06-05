/**
 * Unit suite for `/api/oauth/install` (PR-2c step 3 of the OAuth
 * rollout). Drives the handler in-process via `createApp()` + a fake h3
 * event so we can assert on status codes, redirect URLs, cookie
 * attributes, and the `oauth_state` row that the handler should have
 * persisted.
 *
 * What this suite proves:
 *   - Flag-off → 503 + errorCode `FLAG-OFF` (rolled-back deploy state
 *     should not silently accept install clicks).
 *   - Missing CLIENT_ID or REDIRECT_URL → 503 + errorCode `NOT-CONFIGURED`
 *     (operator partially-configured the OAuth env).
 *   - Bad `?portal=` → 400 + errorCode `PORTAL-FORMAT`. Covers: missing,
 *     non-Bitrix24 host, JS-injection attempt, unlisted TLD.
 *   - Good portal → 302 to `https://<portal>/oauth/authorize/?...` with
 *     `client_id`, `state`, `redirect_uri`, `scope`, `response_type=code`
 *     query params; CSRF cookie set with `HttpOnly; Secure; SameSite=Lax;
 *     Path=/api/oauth/`.
 *   - `oauth_state` row landed: state, portal, clientId, csrfCookie,
 *     expiresAt ≈ now + 5min.
 *   - Cookie value matches the persisted `csrfCookie` (the two are
 *     paired so the callback can verify both).
 *   - State + cookie are each 32 bytes hex (the design's entropy floor).
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createApp, eventHandler, toNodeListener } from 'h3'
import type * as TokenStoreModule from '~/server/utils/token-store'
import { createTokenStore, type TokenStore } from '~/server/utils/token-store'

const runtimeConfig: Record<string, unknown> = {
  bitrix24OauthEnabled: true,
  bitrix24OauthClientId: 'app.cid.12345',
  bitrix24OauthClientSecret: 'super-secret',
  bitrix24OauthRedirectUrl: 'https://mcp.example.com/api/oauth/callback',
  bitrix24OauthScope: 'user,task',
}
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

const loggerCalls: Array<{ level: string; event: string; ctx: Record<string, unknown> | undefined }> = []
function captureLogger(level: string) {
  return (event: string, ctx?: Record<string, unknown>): Promise<void> => {
    loggerCalls.push({ level, event, ctx })
    return Promise.resolve()
  }
}
vi.mock('~/server/utils/logger', () => ({
  useLogger: () => ({
    info: captureLogger('info'),
    warning: captureLogger('warning'),
    error: captureLogger('error'),
    debug: captureLogger('debug'),
    notice: captureLogger('notice'),
  }),
}))

// Drive the install handler against a real `:memory:` token store so the
// `oauth_state` persistence is exercised end-to-end (no double-mocking
// the SQLite layer; the row IS the side-effect we want to assert on).
let db: Database.Database
let store: TokenStore
vi.mock('~/server/utils/token-store', async () => {
  const real = await vi.importActual<typeof TokenStoreModule>('~/server/utils/token-store')
  return {
    ...real,
    useTokenStore: () => store,
  }
})

beforeEach(() => {
  db = new Database(':memory:')
  store = createTokenStore(db)
  loggerCalls.length = 0
  runtimeConfig.bitrix24OauthEnabled = true
  runtimeConfig.bitrix24OauthClientId = 'app.cid.12345'
  runtimeConfig.bitrix24OauthRedirectUrl = 'https://mcp.example.com/api/oauth/callback'
  runtimeConfig.bitrix24OauthScope = 'user,task'
  vi.resetModules()
})

afterEach(() => {
  db.close()
})

/**
 * Drive the handler through h3's real `createApp` + `toNodeListener` so
 * `setCookie` / `sendRedirect` / `createError` go through the same code
 * paths as production. The handler is registered as a route on a tiny
 * test app; we hit it via a Node `IncomingMessage` + `ServerResponse`
 * pair built by hand. Cleaner than mocking h3's internals — the test
 * exercises the real h3 framework end-to-end.
 */
interface CapturedResponse {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  errorCode?: string
}

async function callHandler(query: Record<string, string>): Promise<CapturedResponse> {
  // Fresh app per call so the handler module's mock isolation holds.
  const handler = (await import('~/server/api/oauth/install.get')).default
  const app = createApp({ onError: (err, event) => {
    // Surface createError's `data.errorCode` into the response body so
    // tests can assert on it. Without this, h3's default error path
    // doesn't echo the `data` field into the JSON body.
    const e = err as { statusCode?: number; statusMessage?: string; data?: { errorCode?: string } }
    event.node.res.statusCode = e.statusCode ?? 500
    event.node.res.setHeader('content-type', 'application/json')
    event.node.res.end(JSON.stringify({ statusMessage: e.statusMessage, errorCode: e.data?.errorCode }))
  } })
  app.use('/api/oauth/install', eventHandler(handler))

  const listener = toNodeListener(app)
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = 'GET'
  req.url = `/api/oauth/install?${new URLSearchParams(query).toString()}`
  req.headers = { host: 'mcp.example.com' }

  return await new Promise<CapturedResponse>((resolve) => {
    const chunks: Buffer[] = []
    const res = new ServerResponse(req)
    // Capture the body — h3's sendRedirect writes a short HTML body.
    const origWrite = res.write.bind(res)
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return origWrite(chunk as never, ...rest as never[])
    }) as typeof res.write
    const origEnd = res.end.bind(res)
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      const result = origEnd(chunk as never, ...rest as never[])
      const headers: Record<string, string | string[]> = {}
      for (const name of res.getHeaderNames()) {
        const v = res.getHeader(name)
        if (v !== undefined) headers[name] = v as string | string[]
      }
      const body = Buffer.concat(chunks).toString('utf8')
      let errorCode: string | undefined
      try {
        errorCode = (JSON.parse(body) as { errorCode?: string }).errorCode
      }
      catch { /* not JSON */ }
      resolve({ statusCode: res.statusCode, headers, body, errorCode })
      return result
    }) as typeof res.end

    listener(req, res)
  })
}

describe('/api/oauth/install — flag + config gates', () => {
  it('503 + FLAG-OFF when NUXT_BITRIX24_OAUTH_ENABLED=false', async () => {
    runtimeConfig.bitrix24OauthEnabled = false
    const res = await callHandler({ portal: 'acme.bitrix24.com' })
    expect(res.statusCode).toBe(503)
    expect(res.errorCode).toBe('FLAG-OFF')
    expect(loggerCalls.find(c => c.event === 'oauth.install.deny.flag-off')).toBeDefined()
  })

  it('503 + NOT-CONFIGURED when CLIENT_ID is empty', async () => {
    runtimeConfig.bitrix24OauthClientId = ''
    const res = await callHandler({ portal: 'acme.bitrix24.com' })
    expect(res.statusCode).toBe(503)
    expect(res.errorCode).toBe('NOT-CONFIGURED')
  })

  it('503 + NOT-CONFIGURED when REDIRECT_URL is empty', async () => {
    runtimeConfig.bitrix24OauthRedirectUrl = ''
    const res = await callHandler({ portal: 'acme.bitrix24.com' })
    expect(res.statusCode).toBe(503)
    expect(res.errorCode).toBe('NOT-CONFIGURED')
  })
})

describe('/api/oauth/install — portal allow-list', () => {
  it.each([
    ['empty', ''],
    ['non-bitrix24', 'evil.example.com'],
    ['javascript scheme injection', 'javascript:alert(1)'],
    ['unlisted TLD', 'acme.bitrix24.us'],
    ['no subdomain', 'bitrix24.com'],
    ['path injection', 'acme.bitrix24.com/evil'],
    ['port injection', 'acme.bitrix24.com:8080'],
  ])('400 + PORTAL-FORMAT for %s (%s)', async (_label, portal) => {
    const res = await callHandler(portal === '' ? {} : { portal })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('PORTAL-FORMAT')
    expect(loggerCalls.find(c => c.event === 'oauth.install.deny.portal-format')).toBeDefined()
  })

  it.each([
    'acme.bitrix24.com',
    'sub-portal-123.bitrix24.ru',
    'short.bitrix24.de',
    'x.bitrix24.by',
    'y.bitrix24.kz',
    'z.bitrix24.ua',
    'q.bitrix24.eu',
  ])('accepts %s as a valid portal', async (portal) => {
    const res = await callHandler({ portal })
    expect(res.statusCode).toBe(302)
  })
})

describe('/api/oauth/install — happy path', () => {
  it('redirects to <portal>/oauth/authorize with state + client_id + redirect_uri + scope', async () => {
    const res = await callHandler({ portal: 'acme.bitrix24.com' })
    expect(res.statusCode).toBe(302)
    const location = res.headers.location as string
    expect(location.startsWith('https://acme.bitrix24.com/oauth/authorize/')).toBe(true)
    const url = new URL(location)
    expect(url.searchParams.get('client_id')).toBe('app.cid.12345')
    expect(url.searchParams.get('redirect_uri')).toBe('https://mcp.example.com/api/oauth/callback')
    expect(url.searchParams.get('scope')).toBe('user,task')
    expect(url.searchParams.get('response_type')).toBe('code')
    const state = url.searchParams.get('state')!
    expect(state).toMatch(/^[a-f0-9]{64}$/) // 32 bytes hex
  })

  it('persists an oauth_state row matching the redirect state', async () => {
    const res = await callHandler({ portal: 'acme.bitrix24.com' })
    const state = new URL(res.headers.location as string).searchParams.get('state')!
    const row = store.consumeState(state)
    expect(row).toBeDefined()
    expect(row!.portal).toBe('acme.bitrix24.com')
    expect(row!.clientId).toBe('app.cid.12345')
    // 5-minute TTL (give some slack for timing).
    const now = Math.floor(Date.now() / 1000)
    expect(row!.expiresAt).toBeGreaterThanOrEqual(now + 290)
    expect(row!.expiresAt).toBeLessThanOrEqual(now + 310)
  })

  it('sets a 32-byte hex CSRF cookie with HttpOnly+Secure+SameSite=Lax+Path=/api/oauth/', async () => {
    const res = await callHandler({ portal: 'acme.bitrix24.com' })
    // h3's setHeader stores a single cookie as a string, not as an
    // array of one — normalise so the rest of the test reads uniformly.
    const raw = res.headers['set-cookie']
    expect(raw).toBeDefined()
    const cookie = Array.isArray(raw) ? raw[0]! : raw as string
    // The cookie name is fixed; the value is the entropy nonce.
    expect(cookie).toMatch(/^bx24_oauth_csrf=[a-f0-9]{64};/)
    // Attribute checks — h3's setCookie uses lowercase attribute names.
    expect(cookie.toLowerCase()).toContain('httponly')
    expect(cookie.toLowerCase()).toContain('secure')
    expect(cookie.toLowerCase()).toMatch(/samesite=lax/)
    expect(cookie.toLowerCase()).toContain('path=/api/oauth/')
    expect(cookie.toLowerCase()).toMatch(/max-age=300/) // 5 min
  })

  it('CSRF cookie value matches the persisted oauth_state.csrfCookie', async () => {
    // The two ARE the same nonce (the design pairs them) — the callback
    // verifies the cookie equals the row's csrfCookie field. Without this
    // pin a future refactor could split them into two separate nonces and
    // silently break /callback verification.
    const res = await callHandler({ portal: 'acme.bitrix24.com' })
    const state = new URL(res.headers.location as string).searchParams.get('state')!
    const rawC = res.headers['set-cookie']
    const cookie = Array.isArray(rawC) ? rawC[0]! : rawC as string
    const cookieValue = cookie.match(/^bx24_oauth_csrf=([a-f0-9]{64})/)![1]!
    const row = store.consumeState(state)
    expect(row!.csrfCookie).toBe(cookieValue)
  })

  it('logs oauth.install.start, then oauth.install.ok with statePrefix (8 hex chars only)', async () => {
    const res = await callHandler({ portal: 'acme.bitrix24.com' })
    const state = new URL(res.headers.location as string).searchParams.get('state')!

    const start = loggerCalls.find(c => c.event === 'oauth.install.start')
    expect(start).toBeDefined()
    expect(start!.ctx).toMatchObject({ portal: 'acme.bitrix24.com', clientId: 'app.cid.12345' })

    const ok = loggerCalls.find(c => c.event === 'oauth.install.ok')
    expect(ok).toBeDefined()
    expect(ok!.ctx).toMatchObject({
      portal: 'acme.bitrix24.com',
      clientId: 'app.cid.12345',
      statePrefix: state.slice(0, 8),
    })
    // The full state value is NEVER logged — debug-trace policy in §11.
    expect(JSON.stringify(ok!.ctx)).not.toContain(state)
  })

  it('each call produces a fresh state + cookie (no nonce reuse across requests)', async () => {
    const a = await callHandler({ portal: 'acme.bitrix24.com' })
    const b = await callHandler({ portal: 'acme.bitrix24.com' })
    const stateA = new URL(a.headers.location as string).searchParams.get('state')!
    const stateB = new URL(b.headers.location as string).searchParams.get('state')!
    expect(stateA).not.toBe(stateB)
    const rawA = a.headers['set-cookie']
    const rawB = b.headers['set-cookie']
    const cookieAstr = Array.isArray(rawA) ? rawA[0]! : rawA as string
    const cookieBstr = Array.isArray(rawB) ? rawB[0]! : rawB as string
    const cookieA = cookieAstr.match(/^bx24_oauth_csrf=([a-f0-9]{64})/)![1]
    const cookieB = cookieBstr.match(/^bx24_oauth_csrf=([a-f0-9]{64})/)![1]
    expect(cookieA).not.toBe(cookieB)
  })
})
