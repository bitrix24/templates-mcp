import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit coverage for `bx24mcp_list_session` (#212). The tool sits in front
 * of the new public `TokenStore.listMcpTokens(memberId, userId)` and
 * adds:
 *
 *   - mode guard: refuses outside multi-tenant OAuth deployments
 *     (`NUXT_BITRIX24_OAUTH_ENABLED=false` is webhook-mode or stdio/DXT,
 *     neither of which has a notion of "list of issued Bearers").
 *   - tenant-context guard: refuses when `getTenantContext()` returns
 *     undefined — same friendly-error contract as the existing OAuth
 *     middleware uses for unauthenticated requests.
 *   - input-shape guard: `tenant.userId` arrives as a string from the
 *     ALS; coerce to integer and refuse on NaN.
 *
 * The token-store SQLite half is exercised separately in
 * `tests/unit/utils/token-store.test.ts` — this file mocks the store so
 * the tool's contract stays the assertion, not the SQL.
 */

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const listMcpTokens = vi.fn()
const getTenantContext = vi.fn()
const useRuntimeConfig = vi.fn()

vi.mock('~/server/utils/token-store', () => ({
  useTokenStore: () => ({ listMcpTokens }),
}))

vi.mock('~/server/utils/request-context', () => ({
  getTenantContext,
}))

// The tool reads `useRuntimeConfig()` as a Nuxt global. The Nitro auto-
// imports compile that name from each test file individually; the
// simplest portable shim is to put a getter on `globalThis`.
beforeEach(() => {
  ;(globalThis as { useRuntimeConfig?: typeof useRuntimeConfig }).useRuntimeConfig = useRuntimeConfig
})

afterEach(() => {
  delete (globalThis as { useRuntimeConfig?: typeof useRuntimeConfig }).useRuntimeConfig
  vi.resetAllMocks()
})

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const tool = (await import('../../../../server/mcp/tools/meta/list-sessions')).default as unknown as {
  handler: (input: Record<string, never>) => Promise<ToolResult>
}

describe('bx24mcp_list_session', () => {
  it('refuses in webhook mode with a friendly explanation', async () => {
    useRuntimeConfig.mockReturnValue({ bitrix24OauthEnabled: false })
    const res = await tool.handler({})
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toMatch(/multi-tenant OAuth/)
    expect(listMcpTokens).not.toHaveBeenCalled()
  })

  it('refuses when the tenant context is missing (no Bearer middleware ran)', async () => {
    useRuntimeConfig.mockReturnValue({ bitrix24OauthEnabled: true })
    getTenantContext.mockReturnValue(null)
    const res = await tool.handler({})
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toMatch(/tenant context/)
    expect(listMcpTokens).not.toHaveBeenCalled()
  })

  it('refuses when the tenant userId is not an integer', async () => {
    useRuntimeConfig.mockReturnValue({ bitrix24OauthEnabled: true })
    getTenantContext.mockReturnValue({ memberId: 'm1', userId: 'not-a-number' })
    const res = await tool.handler({})
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).toMatch(/userId/)
    expect(listMcpTokens).not.toHaveBeenCalled()
  })

  it('returns the active sessions for the resolved tenant, scoped to (memberId,userId)', async () => {
    useRuntimeConfig.mockReturnValue({ bitrix24OauthEnabled: true })
    getTenantContext.mockReturnValue({ memberId: 'm1', userId: '42' })
    listMcpTokens.mockReturnValue([
      { bearerHashPrefix: 'aabbccdd', label: 'MacBook', createdAt: 1800000000 },
      { bearerHashPrefix: '11223344', label: null, createdAt: 1799000000 },
    ])

    const res = await tool.handler({})
    expect(res.isError).toBeUndefined()
    expect(listMcpTokens).toHaveBeenCalledWith('m1', 42)

    const payload = JSON.parse(res.content[0]!.text) as {
      memberId: string
      userId: number
      count: number
      sessions: Array<{ bearerHashPrefix: string, label: string | null, createdAt: number }>
    }
    expect(payload.memberId).toBe('m1')
    expect(payload.userId).toBe(42)
    expect(payload.count).toBe(2)
    expect(payload.sessions[0]?.bearerHashPrefix).toBe('aabbccdd')
    expect(payload.sessions[0]?.label).toBe('MacBook')
  })

  it('returns count:0 + empty array for a tenant with no active Bearers (not isError)', async () => {
    useRuntimeConfig.mockReturnValue({ bitrix24OauthEnabled: true })
    getTenantContext.mockReturnValue({ memberId: 'm1', userId: '42' })
    listMcpTokens.mockReturnValue([])
    const res = await tool.handler({})
    expect(res.isError).toBeUndefined()
    const payload = JSON.parse(res.content[0]!.text) as { count: number, sessions: unknown[] }
    expect(payload.count).toBe(0)
    expect(payload.sessions).toEqual([])
  })
})
