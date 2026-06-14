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
  // Brand-styled landing (#233) — defaults match production (off) so
  // the strict-CSP baseline tests keep their meaning. Individual cases
  // flip these locally and restore.
  runtimeConfig.bitrix24OauthBrandStyles = false
  runtimeConfig.bitrix24OauthAppDisplayName = ''
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

async function callHandler(
  query: Record<string, string>,
  opts: { acceptHtml?: boolean, acceptHeader?: string } = {},
): Promise<CapturedResponse> {
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
  // Default Accept-less request mimics curl / fetch with no header — the
  // CLI path that the landing form / HTML deny pages must NEVER swallow.
  // Tests that want the browser branch pass `acceptHtml: true`.
  // `acceptHeader` (raw, set as-is) wins over `acceptHtml` (browser-ish
  // default). Default — neither — mimics curl / fetch without any Accept,
  // the CLI-path that the landing form must never swallow.
  const accept = opts.acceptHeader
    ?? (opts.acceptHtml
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      : undefined)
  req.headers = {
    host: 'mcp.example.com',
    ...(accept ? { accept } : {}),
  }

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

  it('strips C0/C1/DEL control chars from the logged raw portal value (issue #221 — no log-line injection)', async () => {
    // A crafted `?portal=` carrying a newline / CR / ANSI escape must not
    // reach the plain-text log verbatim — otherwise it could forge extra
    // log lines or recolour the operator's terminal. The handler logs a
    // sanitised copy (control chars → `?`) BEFORE the allow-list rejects it.
    const evil = 'acme.bitrix24.com\r\n\x1b[31mFORGED\x1b[0m\x00\x7f\x9b'
    const res = await callHandler({ portal: evil })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('PORTAL-FORMAT')
    for (const event of ['oauth.install.start', 'oauth.install.deny.portal-format']) {
      const call = loggerCalls.find(c => c.event === event)
      expect(call).toBeDefined()
      const logged = (call!.ctx as { portal: string }).portal
      // No raw control character (C0 / DEL / C1) survived into the log
      // payload — check by code point so this assertion carries no control
      // bytes of its own (which a regex literal here would).
      for (const ch of logged) {
        const cp = ch.codePointAt(0)!
        expect(cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f)).toBe(true)
      }
      // The visible hostname text is preserved; only the controls became `?`.
      expect(logged).toContain('acme.bitrix24.com')
    }
  })

  it('caps the logged raw portal value at 253 chars AND keeps it control-char free (issue #221)', async () => {
    // Combined assertion: the 253-cap and the control-char strip are two
    // separate defences (one against log volume, one against log
    // injection). A regression that removed `.replace(...)` would leave
    // the length cap intact, so the length check ALONE would still pass
    // and silently lose the strip — assert both here in the same test.
    const evil = `${'a'.repeat(2000)}.example.com`
    const res = await callHandler({ portal: evil })
    expect(res.statusCode).toBe(400)
    for (const event of ['oauth.install.start', 'oauth.install.deny.portal-format']) {
      const call = loggerCalls.find(c => c.event === event)
      expect(call).toBeDefined()
      const logged = (call!.ctx as { portal: string }).portal
      expect(logged.length).toBeLessThanOrEqual(253)
      // No control code points survived (C0 / DEL / C1 / Bidi / ZW / BOM).
      for (const ch of logged) {
        const cp = ch.codePointAt(0)!
        const isControl = cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)
        const isBidi = (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
        const isZeroWidth = (cp >= 0x200b && cp <= 0x200d) || cp === 0xfeff
        expect(isControl || isBidi || isZeroWidth).toBe(false)
      }
    }
  })

  it('strips Unicode bidi overrides + zero-widths + BOM from the logged portal (issue #221 round-3 — Trojan Source defence)', async () => {
    // A crafted `?portal=` with U+202E (RTL override) would visually
    // reverse the logged hostname in a terminal-aware log viewer; ZWSP
    // would silently split a grep target. Both are stripped before the
    // value reaches the structured log. Built without literal control
    // chars in the test source (using fromCodePoint) — see the same
    // pattern in the C0/C1 test above.
    const rtlOverride = String.fromCodePoint(0x202e) // RIGHT-TO-LEFT OVERRIDE
    const zwsp = String.fromCodePoint(0x200b) // ZERO WIDTH SPACE
    const bom = String.fromCodePoint(0xfeff) // ZERO WIDTH NO-BREAK SPACE / BOM
    const evil = `evil.bitrix24${rtlOverride}${zwsp}${bom}.com`
    const res = await callHandler({ portal: evil })
    expect(res.statusCode).toBe(400) // allow-list rejects it (defence-in-depth — log strip is just to keep operators safe)
    for (const event of ['oauth.install.start', 'oauth.install.deny.portal-format']) {
      const call = loggerCalls.find(c => c.event === event)
      expect(call).toBeDefined()
      const logged = (call!.ctx as { portal: string }).portal
      expect(logged).not.toContain(rtlOverride)
      expect(logged).not.toContain(zwsp)
      expect(logged).not.toContain(bom)
      // Visible hostname text survives unchanged.
      expect(logged).toContain('evil.bitrix24')
    }
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
    // 5-minute TTL with a generous ±10s window. The window is wider than
    // strictly needed (real wall-clock drift between createState and the
    // `now` snapshot below is sub-second on any non-pathological runner)
    // — bigger window costs us nothing in coverage and rules out flakes
    // on slow / contended CI workers. If a future change tightens the
    // assertion below 290..310, switch the suite to vi.useFakeTimers
    // and pin the exact value instead.
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

/**
 * Operator UX (#221 follow-up): a browser hitting `/api/oauth/install`
 * directly — no `?portal=` in the URL — gets a tiny HTML landing form
 * instead of a JSON 400. CLI callers (no `text/html` in Accept) keep
 * the old contract so the docker-smoke script and every `curl`-based
 * probe stay byte-identical. Deny branches (FLAG-OFF, NOT-CONFIGURED,
 * PORTAL-FORMAT) get HTML pages for browsers and JSON for everyone else.
 */
describe('/api/oauth/install — operator UX (browser landing form)', () => {
  it('GET /install with no portal AND Accept: text/html renders the landing form (no state, no cookie)', async () => {
    const res = await callHandler({}, { acceptHtml: true })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.body).toContain('<form')
    expect(res.body).toContain('name="portal"')
    expect(res.body).toContain('Authorize on Bitrix24')
    // Form submits GET back to the same handler — two separate
    // assertions instead of a single regex so a future attribute-order
    // shuffle in the template doesn't break this test for the wrong
    // reason (#232 test review).
    expect(res.body).toContain('action="/api/oauth/install"')
    expect(res.body).toContain('method="get"')
    // No state minted, no cookie set, no oauth.install.start log.
    expect(res.headers['set-cookie']).toBeUndefined()
    expect(loggerCalls.find(c => c.event === 'oauth.install.start')).toBeUndefined()
    // The DEBUG `landing` event IS logged so an operator can spot e.g.
    // a spike of pre-form opens that never convert. It carries `ip` so
    // the §11 alerting recipe works without an nginx access-log join
    // (#232 docs review).
    const landing = loggerCalls.find(c => c.event === 'oauth.install.landing')
    expect(landing).toBeDefined()
    expect(landing!.ctx).toMatchObject({ clientId: 'app.cid.12345' })
    expect(landing!.ctx).toHaveProperty('ip')
  })

  it('GET /install with no portal AND no Accept header returns the existing JSON 400 PORTAL-FORMAT (CLI contract)', async () => {
    const res = await callHandler({})
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('PORTAL-FORMAT')
    expect(res.headers['content-type']).toMatch(/json/)
    // No landing-form HTML body for the CLI path.
    expect(res.body).not.toContain('<form')
  })

  it('GET /install with no portal AND Accept: application/json returns the JSON 400 PORTAL-FORMAT', async () => {
    // Direct override of the Accept header — mimics an MCP-style probe
    // that wants the machine-readable response, not HTML. Uses the
    // unified callHandler `acceptHeader` knob (#232 test review — was
    // an inline duplicate of callHandler before).
    const res = await callHandler({}, { acceptHeader: 'application/json' })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('PORTAL-FORMAT')
  })

  it('GET /install with no portal AND Accept: */* returns the JSON 400 PORTAL-FORMAT (curl default contract #232)', async () => {
    // The curl default (`Accept: */*`) MUST NOT be treated as a browser
    // navigation — otherwise every smoke probe would suddenly start
    // getting HTML. Pinned regression guard.
    const res = await callHandler({}, { acceptHeader: '*/*' })
    expect(res.statusCode).toBe(400)
    expect(res.errorCode).toBe('PORTAL-FORMAT')
    expect(res.body).not.toContain('<form')
  })

  it('GET /install with `Accept: application/json;q=0.9,text/html;q=0.1` STILL renders the landing form (q-factor not parsed)', async () => {
    // Documented decision: q-factor weights are not parsed — a probe
    // explicitly asking for HTML, even at a low priority, still gets
    // HTML. A misbehaving probe can pin a JSON-only contract with
    // `Accept: application/json` (no text/html anywhere).
    const res = await callHandler({}, { acceptHeader: 'application/json;q=0.9,text/html;q=0.1' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<form')
  })

  it('GET /install with valid portal AND Accept: text/html still 302s to Bitrix24 (form-submit happy path)', async () => {
    const res = await callHandler({ portal: 'acme.bitrix24.com' }, { acceptHtml: true })
    expect(res.statusCode).toBe(302)
    expect(String(res.headers.location)).toContain('https://acme.bitrix24.com/oauth/authorize/')
  })

  it('landing form lists the configured OAuth scopes and the app clientId', async () => {
    const res = await callHandler({}, { acceptHtml: true })
    // Default scope per the test fixture is 'user,task' — both <li>s present.
    expect(res.body).toMatch(/<li><code>user<\/code><\/li>/)
    expect(res.body).toMatch(/<li><code>task<\/code><\/li>/)
    expect(res.body).toContain('app.cid.12345')
  })

  it('landing form mirrors PORTAL_ALLOW_LIST_RE in the input pattern attribute (client-side typo guard, NOT a security boundary)', async () => {
    // Derive the expected pattern from the source-of-truth regex —
    // when the allow-list grows a TLD, this test follows automatically
    // instead of failing with a mysterious magic-string mismatch.
    // (#232 test review.)
    const { PORTAL_ALLOW_LIST_RE } = await import('~/server/utils/portal-validation')
    const expectedPattern = PORTAL_ALLOW_LIST_RE.source.replace(/^\^/, '').replace(/\$$/, '')
    const res = await callHandler({}, { acceptHtml: true })
    expect(res.body).toContain(`pattern="${expectedPattern}"`)
  })

  it('landing form is JS-free and inline-style-free (strict-CSP defence-in-depth)', async () => {
    const res = await callHandler({}, { acceptHtml: true })
    // The strict CSP set by setAntiFramingHeaders would block any inline
    // script or style. Body assertions catch a regression that adds one
    // back without thinking through CSP.
    expect(res.body).not.toMatch(/<script/i)
    expect(res.body).not.toMatch(/\sstyle=/i)
    expect(res.body).not.toMatch(/javascript:/i)
  })

  it('landing form carries anti-framing + form-action self CSP (#221 posture extended for the form)', async () => {
    const res = await callHandler({}, { acceptHtml: true })
    expect(res.headers['x-frame-options']).toBe('DENY')
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain('form-action /api/oauth/install')
  })

  it('strict-CSP baseline: NO style-src directive when brand styles are off (the v0.2.0 contract)', async () => {
    const res = await callHandler({}, { acceptHtml: true })
    const csp = String(res.headers['content-security-policy'])
    expect(csp).not.toContain('style-src')
    expect(res.body).not.toContain('<style')
  })

  it('brand styles opt-in (#233): CSP gets style-src nonce + body emits <style nonce> with the SAME value', async () => {
    runtimeConfig.bitrix24OauthBrandStyles = true
    const res = await callHandler({}, { acceptHtml: true })
    const csp = String(res.headers['content-security-policy'])
    // Strict baseline preserved: `default-src 'none'` still there, no
    // 'unsafe-inline', no relaxed script-src.
    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain("'unsafe-inline'")
    // The added directive carries a fresh nonce. Capture it and pin
    // that the same value appears in the rendered `<style nonce="…">`
    // — a mismatch would silently render the page unstyled in a real
    // browser, which is exactly what this test catches.
    const m = csp.match(/style-src 'nonce-([A-Za-z0-9+/=]+)'/)
    expect(m, 'CSP should add a style-src nonce directive').not.toBeNull()
    const nonce = m![1]!
    expect(nonce.length).toBeGreaterThanOrEqual(16) // base64 of 16 random bytes is >=22 chars
    expect(res.body).toContain(`<style nonce="${nonce}">`)
    // The <script> still must NOT appear (script-src was never relaxed).
    expect(res.body).not.toMatch(/<script/i)
    runtimeConfig.bitrix24OauthBrandStyles = false
  })

  it('brand-styles per-response nonce is fresh: two GETs produce different nonces (no static literal regression)', async () => {
    runtimeConfig.bitrix24OauthBrandStyles = true
    const a = await callHandler({}, { acceptHtml: true })
    const b = await callHandler({}, { acceptHtml: true })
    const nonceA = String(a.headers['content-security-policy']).match(/style-src 'nonce-([A-Za-z0-9+/=]+)'/)?.[1]
    const nonceB = String(b.headers['content-security-policy']).match(/style-src 'nonce-([A-Za-z0-9+/=]+)'/)?.[1]
    expect(nonceA).toBeTruthy()
    expect(nonceB).toBeTruthy()
    expect(nonceA).not.toBe(nonceB)
    runtimeConfig.bitrix24OauthBrandStyles = false
  })

  it('anti-phishing hostname disclosure is rendered on EVERY landing — even without brand styles', async () => {
    // The Host the test app sees is the default the h3 IncomingMessage
    // produces; we don't pin a specific literal here because that's
    // brittle, just that SOMETHING resembling the disclosure block is
    // emitted and the literal "You are connecting to:" anchor is there.
    const res = await callHandler({}, { acceptHtml: true })
    expect(res.body).toContain('You are connecting to:')
  })

  it('fork branding via NUXT_BITRIX24_OAUTH_APP_DISPLAY_NAME: heading + identity line both reflect the override; defaults restored when empty', async () => {
    runtimeConfig.bitrix24OauthAppDisplayName = 'Acme Bitrix24'
    let res = await callHandler({}, { acceptHtml: true })
    expect(res.body).toContain('<h1>Connect your Acme Bitrix24</h1>')
    expect(res.body).toContain('<strong>Acme Bitrix24</strong>')

    runtimeConfig.bitrix24OauthAppDisplayName = ''
    res = await callHandler({}, { acceptHtml: true })
    expect(res.body).toContain('<h1>Connect your Bitrix24 portal</h1>')
    // The identity line falls back to "Bitrix24 application <clientId>"
    expect(res.body).toContain('This server identifies as Bitrix24 application')
  })

  it('display name is HTML-escaped — a hostile env value cannot inject script tags', async () => {
    runtimeConfig.bitrix24OauthAppDisplayName = '<script>alert(1)</script>'
    const res = await callHandler({}, { acceptHtml: true })
    expect(res.body).not.toContain('<script>alert(1)</script>')
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    runtimeConfig.bitrix24OauthAppDisplayName = ''
  })

  it('FLAG-OFF + Accept: text/html renders the HTML 503 (no retry link — operator-fixable, not user-fixable)', async () => {
    runtimeConfig.bitrix24OauthEnabled = false
    const res = await callHandler({}, { acceptHtml: true })
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.body).toContain('FLAG-OFF')
    expect(res.body).toContain('OAuth installation is disabled')
    expect(res.body).not.toContain('Start over')
  })

  it('NOT-CONFIGURED + Accept: text/html renders the HTML 503 (no retry link)', async () => {
    runtimeConfig.bitrix24OauthClientId = ''
    const res = await callHandler({ portal: 'acme.bitrix24.com' }, { acceptHtml: true })
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.body).toContain('NOT-CONFIGURED')
    expect(res.body).not.toContain('Start over')
  })

  it('PORTAL-FORMAT + Accept: text/html renders an HTML 400 WITH a "Start over" retry link (user-fixable)', async () => {
    const res = await callHandler({ portal: 'evil.example.com' }, { acceptHtml: true })
    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toMatch(/^text\/html/)
    expect(res.body).toContain('PORTAL-FORMAT')
    // Retry link points back to /api/oauth/install (no query) → renders
    // the form again. Lets the user fix a typo without a back-button trip.
    expect(res.body).toContain('href="/api/oauth/install"')
    expect(res.body).toContain('Start over')
  })

  it('flag gate logs `oauth.install.deny.flag-off` whether the caller is a browser or CLI', async () => {
    // Symmetry check: HTML branch must not skip the audit log just because
    // it returns nice HTML. The deny event is the operator's signal.
    runtimeConfig.bitrix24OauthEnabled = false
    loggerCalls.length = 0
    await callHandler({}, { acceptHtml: true })
    expect(loggerCalls.find(c => c.event === 'oauth.install.deny.flag-off')).toBeDefined()
    runtimeConfig.bitrix24OauthEnabled = true
    loggerCalls.length = 0
    await callHandler({})
    expect(loggerCalls.find(c => c.event === 'oauth.install.deny.flag-off')).toBeUndefined()
    // Positive assertion (#232 test review): without flag-off, the
    // CLI path with empty portal still emits the deny.portal-format
    // event so the test fails if the handler short-circuits to nothing.
    expect(loggerCalls.find(c => c.event === 'oauth.install.deny.portal-format')).toBeDefined()
  })

  it('HTML-escapes a malicious clientId injected via the runtime config (XSS regression guard #232)', async () => {
    // The runtime config is operator-controlled, but a CI/CD pipeline
    // or a fork that templates the env from an upstream source could
    // smuggle HTML metachars. htmlEscape is the only thing between
    // them and the rendered landing page — pin its behaviour.
    runtimeConfig.bitrix24OauthClientId = 'app<script>alert(1)</script>&"id\'X'
    const res = await callHandler({}, { acceptHtml: true })
    expect(res.statusCode).toBe(200)
    // None of the dangerous metachars survive raw into the body.
    expect(res.body).not.toContain('<script>alert(1)')
    expect(res.body).not.toContain('app<script')
    // The properly escaped form does appear.
    expect(res.body).toContain('app&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;id&#39;X')
  })

  it('empty scope env falls back to `user,task` in the landing form (regression guard for the `|| user,task` default)', async () => {
    runtimeConfig.bitrix24OauthScope = ''
    const res = await callHandler({}, { acceptHtml: true })
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(/<li><code>user<\/code><\/li>/)
    expect(res.body).toMatch(/<li><code>task<\/code><\/li>/)
  })

  it('landing render does NOT count against the rate-limit bucket (#232 security: F5 must not self-ban)', async () => {
    // The bucket-skip is implemented in the rate-limit middleware
    // (a unit test of which lives in `oauth-rate-limit.test.ts`).
    // From the install-handler side we pin the upstream-visible
    // contract: a string of landing renders never sets `Retry-After`,
    // never mints state, never sets cookies, never emits
    // `deny.rate-limited`.
    for (let i = 0; i < 20; i++) {
      const res = await callHandler({}, { acceptHtml: true })
      expect(res.statusCode).toBe(200)
      expect(res.headers['retry-after']).toBeUndefined()
    }
    expect(loggerCalls.find(c => c.event === 'oauth.install.deny.rate-limited')).toBeUndefined()
  })
})
