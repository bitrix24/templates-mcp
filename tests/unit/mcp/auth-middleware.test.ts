/**
 * Unit suite for the MCP Bearer-auth middleware (issue #217, the load-
 * bearing last wire of the OAuth rollout). Lives in `server/mcp/index.ts`
 * as a `defineMcpHandler({ middleware })` override.
 *
 * The middleware extracts `Authorization: Bearer <token>`, hashes it,
 * resolves via `useTokenStore().inspectBearer(hash)`, and on the happy
 * path wraps `next()` in `runWithTenant({memberId, userId, requestId}, …)`.
 * Three distinct deny branches (§11 taxonomy):
 *   - bearer-unknown   (no row at all, or no Bearer header)
 *   - bearer-revoked   (row exists with revoked_at set)
 *   - bearer-orphan    (row alive but oauth_tokens parent missing)
 *
 * The toolkit's `middleware` hook is `(event, next) => Promise<Response | void>`.
 * We test the middleware in isolation by invoking it directly (no real
 * h3 server) with a fake h3 event + a sniffing `next` that captures the
 * tenant context (via `getTenantContext`) and the generated requestId
 * (via `getRequestId`) at the moment of dispatch.
 */
import { createHash } from 'node:crypto'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createEvent, type H3Event } from 'h3'
import type * as AuditLogModule from '~/server/utils/audit-log'
import type * as TokenStoreModule from '~/server/utils/token-store'
import { createTokenStore, type TokenStore } from '~/server/utils/token-store'

const runtimeConfig: Record<string, unknown> = {
  bitrix24OauthEnabled: true,
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

// Audit log no-op — the middleware itself doesn't audit (Bearer
// inspection is read-only), but `createMcpToken` in the setup path
// does. Mock to keep the CI happy without /data write permission.
type AuditEvent = Parameters<typeof AuditLogModule.recordAuditEvent>[0]
const { recordAuditEvent } = vi.hoisted(() => ({
  recordAuditEvent: vi.fn<(event: AuditEvent) => Promise<void>>(async () => undefined),
}))
vi.mock('~/server/utils/audit-log', async () => {
  const real = await vi.importActual<typeof AuditLogModule>('~/server/utils/audit-log')
  return { ...real, recordAuditEvent }
})

let db: Database.Database
let store: TokenStore
vi.mock('~/server/utils/token-store', async () => {
  const real = await vi.importActual<typeof TokenStoreModule>('~/server/utils/token-store')
  return { ...real, useTokenStore: () => store }
})

// Stub `defineMcpHandler` — under Vitest the auto-import isn't materialised
// from `@nuxtjs/mcp-toolkit/server`. The stub returns the options
// unchanged so we can pull the `middleware` function off the default
// export and drive it directly.
vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpHandler: <T,>(spec: T) => spec,
}))

const SAMPLE_TENANT = {
  memberId: 'portal-acme',
  userId: 42,
  portalDomain: 'acme.bitrix24.com',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  scope: 'user,task',
}

beforeEach(() => {
  db = new Database(':memory:')
  store = createTokenStore(db)
  loggerCalls.length = 0
  recordAuditEvent.mockClear()
  runtimeConfig.bitrix24OauthEnabled = true
  vi.resetModules()
})
afterEach(() => {
  db.close()
})

/** Build a minimal H3Event with optional Authorization header. */
function makeEvent(headers: Record<string, string> = {}): H3Event {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  req.method = 'POST'
  req.url = '/mcp'
  req.headers = { host: 'mcp.example.com', ...headers }
  const res = new ServerResponse(req)
  return createEvent(req, res)
}

interface HandlerOpts {
  middleware: (
    event: H3Event,
    next: () => Promise<unknown>,
  ) => Promise<unknown> | unknown
}

async function loadMiddleware(): Promise<HandlerOpts['middleware']> {
  const mod = await import('~/server/mcp/index') as { default: HandlerOpts }
  return mod.default.middleware
}

describe('MCP Bearer middleware — flag-off pass-through', () => {
  it('NUXT_BITRIX24_OAUTH_ENABLED=false → passes next() through, no auth done', async () => {
    runtimeConfig.bitrix24OauthEnabled = false
    const middleware = await loadMiddleware()
    const event = makeEvent() // no Authorization header
    const nextSentinel = { ok: true } as const
    const result = await middleware(event, async () => nextSentinel)
    expect(result).toBe(nextSentinel)
    // No deny events logged — the h3 mcp-auth.ts middleware owns this path.
    expect(loggerCalls.find(c => c.event.startsWith('mcp.auth'))).toBeUndefined()
  })
})

describe('MCP Bearer middleware — deny branches (§11 taxonomy)', () => {
  it('401 BEARER-UNKNOWN + WWW-Authenticate when Authorization header is absent', async () => {
    const middleware = await loadMiddleware()
    const event = makeEvent()
    await expect(middleware(event, async () => ({}))).rejects.toMatchObject({
      statusCode: 401,
      data: { errorCode: 'BEARER-UNKNOWN' },
    })
    expect(event.node.res.getHeader('www-authenticate')).toMatch(/^Bearer error="invalid_token"/)
    expect(event.node.res.getHeader('www-authenticate')).toMatch(/errorCode="BEARER-UNKNOWN"/)
    const denial = loggerCalls.find(c => c.event === 'mcp.auth.deny.bearer-unknown')
    expect(denial).toBeDefined()
    expect(denial!.ctx).toMatchObject({ reason: 'no-bearer' })
  })

  it('401 BEARER-UNKNOWN when Bearer is not in mcp_tokens', async () => {
    const middleware = await loadMiddleware()
    const event = makeEvent({ authorization: `Bearer ${'a'.repeat(64)}` })
    await expect(middleware(event, async () => ({}))).rejects.toMatchObject({
      statusCode: 401,
      data: { errorCode: 'BEARER-UNKNOWN' },
    })
    // The logged context carries the hash PREFIX (sha256-<8 hex>) — not
    // the raw Bearer, and not the full hash either.
    const denial = loggerCalls.find(c => c.event === 'mcp.auth.deny.bearer-unknown' && c.ctx?.bearerHashPrefix)
    expect(denial).toBeDefined()
    expect((denial!.ctx as { bearerHashPrefix: string }).bearerHashPrefix).toMatch(/^sha256-[a-f0-9]{8}$/)
  })

  it('401 BEARER-REVOKED when the Bearer row exists but is revoked', async () => {
    await store.upsertTokens(SAMPLE_TENANT, 'install')
    const { bearer } = await store.createMcpToken(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId, 'laptop', 'install')
    const bearerHash = `sha256-${createHash('sha256').update(bearer).digest('hex')}`
    await store.revokeMcpToken(bearerHash, 'user')

    const middleware = await loadMiddleware()
    const event = makeEvent({ authorization: `Bearer ${bearer}` })
    await expect(middleware(event, async () => ({}))).rejects.toMatchObject({
      statusCode: 401,
      data: { errorCode: 'BEARER-REVOKED' },
    })
    // Pin the full RFC 6750 §3 header shape, not just the errorCode —
    // a refactor that drops `Bearer error="invalid_token"` breaks every
    // RFC-compliant OAuth client and must fail this test.
    const wwwAuth = event.node.res.getHeader('www-authenticate') as string
    expect(wwwAuth).toMatch(/^Bearer error="invalid_token"/)
    expect(wwwAuth).toMatch(/errorCode="BEARER-REVOKED"/)
    expect(wwwAuth).toMatch(/error_description=".*"/)
    const denial = loggerCalls.find(c => c.event === 'mcp.auth.deny.bearer-revoked')
    expect(denial).toBeDefined()
    expect(denial!.ctx).toMatchObject({
      memberId: SAMPLE_TENANT.memberId,
      userId: SAMPLE_TENANT.userId,
    })
    expect(typeof (denial!.ctx as { revokedAt: number }).revokedAt).toBe('number')
  })

  it('401 BEARER-ORPHAN when mcp_tokens row is active but oauth_tokens parent is gone', async () => {
    // The defensive log per §11: CASCADE prevents this, but a manual
    // SQLite edit could create the state. We simulate by inserting an
    // orphan row directly via the better-sqlite3 instance.
    const bearer = 'ff'.repeat(32)
    const bearerHash = `sha256-${createHash('sha256').update(bearer).digest('hex')}`
    // Disable FK so the orphan insert sticks (production has FK on).
    db.pragma('foreign_keys = OFF')
    db.prepare('INSERT INTO mcp_tokens (bearer_hash, member_id, user_id, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(bearerHash, 'ghost-portal', 99, null, Math.floor(Date.now() / 1000))
    db.pragma('foreign_keys = ON')

    const middleware = await loadMiddleware()
    const event = makeEvent({ authorization: `Bearer ${bearer}` })
    await expect(middleware(event, async () => ({}))).rejects.toMatchObject({
      statusCode: 401,
      data: { errorCode: 'BEARER-ORPHAN' },
    })
    const denial = loggerCalls.find(c => c.event === 'mcp.auth.deny.bearer-orphan')
    expect(denial).toBeDefined()
    expect(denial!.level).toBe('error') // §11: orphan is ERROR, not WARN
    expect(denial!.ctx).toMatchObject({ memberId: 'ghost-portal', userId: 99 })
    // Header shape pinned (RFC 6750 §3).
    const wwwAuth = event.node.res.getHeader('www-authenticate') as string
    expect(wwwAuth).toMatch(/^Bearer error="invalid_token"/)
    expect(wwwAuth).toMatch(/errorCode="BEARER-ORPHAN"/)
  })

  it('BEARER-REVOKED takes precedence over BEARER-ORPHAN when both conditions hold', async () => {
    // Reordering the two `if`s inside the middleware would change which
    // errorCode a row with BOTH `revoked_at` set AND a missing tenant
    // resolves to. Pin the precedence: revoked is checked first.
    const bearer = 'ee'.repeat(32)
    const bearerHash = `sha256-${createHash('sha256').update(bearer).digest('hex')}`
    const now = Math.floor(Date.now() / 1000)
    db.pragma('foreign_keys = OFF')
    db.prepare('INSERT INTO mcp_tokens (bearer_hash, member_id, user_id, label, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(bearerHash, 'ghost-portal', 99, null, now, now) // revoked AND orphan
    db.pragma('foreign_keys = ON')

    const middleware = await loadMiddleware()
    const event = makeEvent({ authorization: `Bearer ${bearer}` })
    await expect(middleware(event, async () => ({}))).rejects.toMatchObject({
      statusCode: 401,
      data: { errorCode: 'BEARER-REVOKED' },
    })
  })
})

describe('MCP Bearer middleware — happy path', () => {
  it('wraps next() in runWithTenant({memberId, userId, requestId}); requestId is 32-char hex', async () => {
    await store.upsertTokens(SAMPLE_TENANT, 'install')
    const { bearer } = await store.createMcpToken(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId, 'laptop', 'install')

    const middleware = await loadMiddleware()
    const event = makeEvent({ authorization: `Bearer ${bearer}` })

    // Sniff the tenant context + requestId from inside next().
    const { getTenantContext, getRequestId } = await import('~/server/utils/request-context')
    let observedCtx: ReturnType<typeof getTenantContext>
    let observedRequestId = ''
    const result = await middleware(event, async () => {
      observedCtx = getTenantContext()
      observedRequestId = getRequestId()
      return 'tool-result'
    })
    expect(result).toBe('tool-result')
    expect(observedCtx).toBeDefined()
    expect(observedCtx!.memberId).toBe(SAMPLE_TENANT.memberId)
    expect(observedCtx!.userId).toBe(String(SAMPLE_TENANT.userId)) // stringified per §7
    expect(observedRequestId).toMatch(/^[a-f0-9]{32}$/)

    const ok = loggerCalls.find(c => c.event === 'mcp.auth.ok')
    expect(ok).toBeDefined()
    expect(ok!.ctx).toMatchObject({
      memberId: SAMPLE_TENANT.memberId,
      userId: SAMPLE_TENANT.userId,
      requestId: observedRequestId,
    })
    // bearerHashPrefix is the sha256-<8hex> identifier, never the raw Bearer.
    expect((ok!.ctx as { bearerHashPrefix: string }).bearerHashPrefix).toMatch(/^sha256-[a-f0-9]{8}$/)
    // The raw Bearer NEVER appears in any log line.
    for (const call of loggerCalls) {
      expect(JSON.stringify(call.ctx ?? {})).not.toContain(bearer)
    }
  })

  it('ALS scope closes after next() resolves — getTenantContext() is undefined outside the wrap', async () => {
    // Defends against a `enterWith`-style regression that would leak
    // the tenant context to the global scope. The middleware MUST use
    // `als.run(store, fn)`, NOT `als.enterWith(store)` — the former
    // restores the previous scope when fn resolves, the latter doesn't.
    await store.upsertTokens(SAMPLE_TENANT, 'install')
    const { bearer } = await store.createMcpToken(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId, 'laptop', 'install')
    const { getTenantContext } = await import('~/server/utils/request-context')

    const middleware = await loadMiddleware()
    const event = makeEvent({ authorization: `Bearer ${bearer}` })
    await middleware(event, async () => 'done')
    // Outside the wrap (after middleware resolves) the ALS scope MUST
    // be empty. A persistent context would leak across requests on the
    // same worker → cross-tenant data class.
    expect(getTenantContext()).toBeUndefined()
  })

  it('N=2 concurrent requests with distinct Bearers each see THEIR OWN tenant inside next()', async () => {
    // Cross-tenant ALS isolation at the middleware layer (the same
    // guarantee PR-2a's #64 ALS spike pinned at the toolkit dispatch
    // layer). If `runWithTenant` used a shared mutable store, the two
    // concurrent middleware invocations would race and see each other's
    // tenants — exactly the bug class OAuth multi-tenant exists to
    // prevent.
    await store.upsertTokens({ ...SAMPLE_TENANT, memberId: 'portal-a', userId: 1 }, 'install')
    await store.upsertTokens({ ...SAMPLE_TENANT, memberId: 'portal-b', userId: 2 }, 'install')
    const { bearer: bearerA } = await store.createMcpToken('portal-a', 1, 'a', 'install')
    const { bearer: bearerB } = await store.createMcpToken('portal-b', 2, 'b', 'install')
    const { getTenantContext } = await import('~/server/utils/request-context')

    const middleware = await loadMiddleware()
    const eventA = makeEvent({ authorization: `Bearer ${bearerA}` })
    const eventB = makeEvent({ authorization: `Bearer ${bearerB}` })
    const [observedA, observedB] = await Promise.all([
      middleware(eventA, async () => {
        await new Promise<void>(r => setImmediate(r)) // force interleave
        return getTenantContext()?.memberId
      }),
      middleware(eventB, async () => {
        await new Promise<void>(r => setImmediate(r))
        return getTenantContext()?.memberId
      }),
    ])
    expect(observedA).toBe('portal-a')
    expect(observedB).toBe('portal-b')
  })

  it('each request gets a fresh requestId (no correlation-id reuse)', async () => {
    await store.upsertTokens(SAMPLE_TENANT, 'install')
    const { bearer } = await store.createMcpToken(SAMPLE_TENANT.memberId, SAMPLE_TENANT.userId, 'laptop', 'install')
    const { getRequestId } = await import('~/server/utils/request-context')

    const middleware = await loadMiddleware()
    const captured: string[] = []
    for (let i = 0; i < 3; i++) {
      const event = makeEvent({ authorization: `Bearer ${bearer}` })
      await middleware(event, async () => { captured.push(getRequestId()) })
    }
    expect(new Set(captured).size).toBe(3) // all distinct
  })
})
