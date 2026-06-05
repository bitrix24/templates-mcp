/**
 * Unit suite for `/api/oauth/_health` (PR-2c step 4, design in
 * `docs/OAUTH-DESIGN.md §11`). The §11 contract is mandatory: the route
 * MUST fail closed without an admin token AND without localhost
 * isolation — otherwise it ships open on first deploy. These tests
 * pin the four cases the design doc spelled out:
 *
 *   1. Default config (no admin token, no localhost) → 503.
 *   2. Admin token set + no Bearer header → 401.
 *   3. Admin token set + wrong Bearer → 401.
 *   4. Admin token set + correct Bearer → 200 + counts shape.
 *
 * Plus negative cases for flag-off and localhost-without-token (the
 * accepted "network-isolation" pattern).
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createApp, eventHandler, toNodeListener } from 'h3'
import type * as AuditLogModule from '~/server/utils/audit-log'
import type * as TokenStoreModule from '~/server/utils/token-store'
import { createTokenStore, type TokenStore } from '~/server/utils/token-store'

// Mock the audit log — same rationale as callback.test.ts. The "counts"
// test calls `upsertTokens` / `createMcpToken` / `revokeMcpToken`, each
// of which audits; on CI the real audit-log can't `mkdir /data/audit`.
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
  bitrix24OauthAdminToken: '',
  bitrix24OauthDbDir: '/data',
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

beforeEach(() => {
  db = new Database(':memory:')
  store = createTokenStore(db)
  loggerCalls.length = 0
  runtimeConfig.bitrix24OauthEnabled = true
  runtimeConfig.bitrix24OauthAdminToken = ''
  runtimeConfig.bitrix24OauthDbDir = '/data'
  vi.resetModules()
})
afterEach(() => {
  db.close()
})

interface Response {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  errorCode?: string
  json?: Record<string, unknown>
}

/**
 * Drive the route through h3's real listener. `sourceIp` controls the
 * IncomingMessage's underlying socket so `getRequestIP` resolves to the
 * value we want (e.g. `127.0.0.1` for the localhost-isolation path).
 */
async function callHealth(opts: { authorization?: string; sourceIp?: string } = {}): Promise<Response> {
  const handler = (await import('~/server/api/oauth/_health.get')).default
  const app = createApp({ onError: (err, event) => {
    const e = err as { statusCode?: number; statusMessage?: string; data?: { errorCode?: string } }
    event.node.res.statusCode = e.statusCode ?? 500
    event.node.res.setHeader('content-type', 'application/json')
    event.node.res.end(JSON.stringify({ statusMessage: e.statusMessage, errorCode: e.data?.errorCode }))
  } })
  app.use('/api/oauth/_health', eventHandler(handler))
  const listener = toNodeListener(app)

  const socket = new Socket()
  // h3's `getRequestIP` checks `event.node.req.socket.remoteAddress`
  // first when `xForwardedFor` is not set on the header — we override
  // the underlying socket attribute to drive the localhost-vs-not test
  // matrix deterministically.
  Object.defineProperty(socket, 'remoteAddress', { value: opts.sourceIp ?? '203.0.113.10', configurable: true })

  const req = new IncomingMessage(socket)
  req.method = 'GET'
  req.url = '/api/oauth/_health'
  req.headers = { host: 'mcp.example.com', ...(opts.authorization ? { authorization: opts.authorization } : {}) }

  return await new Promise<Response>((resolve) => {
    const chunks: Buffer[] = []
    const res = new ServerResponse(req)
    const origWrite = res.write.bind(res)
    res.write = ((c: unknown, ...r: unknown[]) => {
      if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
      return origWrite(c as never, ...r as never[])
    }) as typeof res.write
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
      let json: Record<string, unknown> | undefined
      let errorCode: string | undefined
      try {
        json = JSON.parse(body) as Record<string, unknown>
        errorCode = json.errorCode as string | undefined
      }
      catch { /* not JSON */ }
      resolve({ statusCode: res.statusCode, headers, body, errorCode, json })
      return result
    }) as typeof res.end
    listener(req, res)
  })
}

describe('/api/oauth/_health — gating', () => {
  it('503 FLAG-OFF when OAuth is disabled', async () => {
    runtimeConfig.bitrix24OauthEnabled = false
    const res = await callHealth({ sourceIp: '127.0.0.1' })
    expect(res.statusCode).toBe(503)
    expect(res.errorCode).toBe('FLAG-OFF')
  })

  it('503 NOT-CONFIGURED when neither admin token nor localhost (default ships closed)', async () => {
    // The mandatory §11 case: with default config (no token, no
    // network isolation), the route refuses. This is the test that
    // catches a future PR-2c regression that silently opens the route.
    const res = await callHealth({ sourceIp: '10.0.0.5' })
    expect(res.statusCode).toBe(503)
    expect(res.errorCode).toBe('NOT-CONFIGURED')
  })

  it('200 when no token but request from localhost (network-isolation path)', async () => {
    const res = await callHealth({ sourceIp: '127.0.0.1' })
    expect(res.statusCode).toBe(200)
    expect(res.json!.enabled).toBe(true)
  })

  it('200 when no token but request from ::1 IPv6 localhost', async () => {
    const res = await callHealth({ sourceIp: '::1' })
    expect(res.statusCode).toBe(200)
  })

  it('401 ADMIN-TOKEN-MISSING when token configured, request from outside localhost, no Bearer', async () => {
    runtimeConfig.bitrix24OauthAdminToken = 'a'.repeat(64)
    const res = await callHealth({ sourceIp: '203.0.113.10' })
    expect(res.statusCode).toBe(401)
    expect(res.errorCode).toBe('ADMIN-TOKEN-MISSING')
  })

  it('401 ADMIN-TOKEN-INVALID when wrong Bearer', async () => {
    runtimeConfig.bitrix24OauthAdminToken = 'a'.repeat(64)
    const res = await callHealth({ sourceIp: '203.0.113.10', authorization: `Bearer ${'b'.repeat(64)}` })
    expect(res.statusCode).toBe(401)
    expect(res.errorCode).toBe('ADMIN-TOKEN-INVALID')
  })

  it('200 with correct admin token (from anywhere)', async () => {
    const token = 'a'.repeat(64)
    runtimeConfig.bitrix24OauthAdminToken = token
    const res = await callHealth({ sourceIp: '203.0.113.10', authorization: `Bearer ${token}` })
    expect(res.statusCode).toBe(200)
    expect(res.json!.enabled).toBe(true)
  })

  it('does NOT fall back to MCP_AUTH_TOKEN (privilege-separation invariant)', async () => {
    // The §11 invariant: `NUXT_MCP_AUTH_TOKEN` (the agent token) must
    // never satisfy the admin gate. If a future refactor pulls in
    // `mcpAuthToken` as a fallback, this test catches it.
    runtimeConfig.bitrix24OauthAdminToken = 'admin-token'
    runtimeConfig.mcpAuthToken = 'agent-token'
    const res = await callHealth({ sourceIp: '203.0.113.10', authorization: 'Bearer agent-token' })
    expect(res.statusCode).toBe(401)
    expect(res.errorCode).toBe('ADMIN-TOKEN-INVALID')
  })

  it('admin token wins over localhost — token configured means token-only auth even from 127.0.0.1', async () => {
    // Intentional design: once the operator opts in to token-based
    // auth, the route is uniformly gated by the token (no implicit
    // localhost bypass). A dev box must include the Bearer too.
    runtimeConfig.bitrix24OauthAdminToken = 'a'.repeat(64)
    const res = await callHealth({ sourceIp: '127.0.0.1' })
    expect(res.statusCode).toBe(401)
    expect(res.errorCode).toBe('ADMIN-TOKEN-MISSING')
  })
})

describe('/api/oauth/_health — counts shape', () => {
  it('returns zero counts on a fresh empty DB', async () => {
    const res = await callHealth({ sourceIp: '127.0.0.1' })
    expect(res.statusCode).toBe(200)
    expect(res.json).toMatchObject({
      enabled: true,
      dbPath: '/data/oauth.sqlite',
      tenants: 0,
      bearers: 0,
      pendingStates: 0,
      lastRefreshOk: null,
      lastRefreshFail: null,
    })
  })

  it('counts tenants + bearers + pending states', async () => {
    // Set up a realistic mini-state: 2 tenants, 3 Bearers across them,
    // 1 pending state. Counts MUST match the SQL queries.
    await store.upsertTokens({
      memberId: 'portal-a', userId: 1, portalDomain: 'a.bitrix24.com',
      accessToken: 'a', refreshToken: 'r', accessExpiresAt: 999999, scope: 'user',
    }, 'install')
    await store.upsertTokens({
      memberId: 'portal-b', userId: 2, portalDomain: 'b.bitrix24.com',
      accessToken: 'a', refreshToken: 'r', accessExpiresAt: 999999, scope: 'user',
    }, 'install')
    await store.createMcpToken('portal-a', 1, 'laptop', 'install')
    await store.createMcpToken('portal-a', 1, 'desktop', 'install')
    await store.createMcpToken('portal-b', 2, 'phone', 'install')
    // One revoked Bearer — must NOT count toward active total.
    const { bearerHash } = await store.createMcpToken('portal-b', 2, 'dead', 'install')
    await store.revokeMcpToken(bearerHash, 'user')
    // One pending state.
    store.createState({
      state: '0'.repeat(64),
      portal: 'a.bitrix24.com',
      clientId: 'cid',
      csrfCookie: '1'.repeat(64),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })

    const res = await callHealth({ sourceIp: '127.0.0.1' })
    expect(res.json).toMatchObject({
      tenants: 2,
      bearers: 3, // 4 minted, 1 revoked
      pendingStates: 1,
    })
  })

  it('does NOT count expired states in `pendingStates`', async () => {
    // The COUNT(*) uses `expires_at > now`, so anything past TTL is
    // excluded even before pruneExpiredStates runs.
    store.createState({
      state: '0'.repeat(64), portal: 'a.bitrix24.com', clientId: 'c',
      csrfCookie: '1'.repeat(64),
      expiresAt: Math.floor(Date.now() / 1000) - 60, // expired
    })
    store.createState({
      state: '2'.repeat(64), portal: 'a.bitrix24.com', clientId: 'c',
      csrfCookie: '3'.repeat(64),
      expiresAt: Math.floor(Date.now() / 1000) + 300, // future
    })
    const res = await callHealth({ sourceIp: '127.0.0.1' })
    expect(res.json!.pendingStates).toBe(1)
  })

  it('logs oauth.health.ok with the counts payload', async () => {
    await callHealth({ sourceIp: '127.0.0.1' })
    const ok = loggerCalls.find(c => c.event === 'oauth.health.ok')
    expect(ok).toBeDefined()
    expect(ok!.ctx).toMatchObject({ tenants: 0, bearers: 0, pendingStates: 0 })
  })

  it('dbPath reflects NUXT_BITRIX24_OAUTH_DB_DIR', async () => {
    runtimeConfig.bitrix24OauthDbDir = '/srv/oauth'
    const res = await callHealth({ sourceIp: '127.0.0.1' })
    expect(res.json!.dbPath).toBe('/srv/oauth/oauth.sqlite')
  })
})
