import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeOk, fakeOkEmpty, makeFakeBitrix24 } from '../../_helpers/bitrix24-mock'

vi.mock('@nuxtjs/mcp-toolkit/server', () => ({
  defineMcpTool: <T,>(spec: T) => spec,
}))

const fake = makeFakeBitrix24()

vi.mock('~/server/utils/bitrix24', () => ({
  useBitrix24: () => fake.b24,
}))

// Silence the dispatcher's `useLogger().error(...)` call on the flag-on
// path (round-3 review: PR-2d test isolation). Without this mock, the
// flag-on test materialises the real SDK Logger and writes to stderr
// during the test run — noisy in CI and couples this tool test to the
// concrete logger implementation. The dispatcher's own behaviour is
// already covered by `tests/unit/utils/bitrix24-tenant.test.ts`.
vi.mock('~/server/utils/logger', () => ({
  useLogger: () => ({ error: vi.fn(), info: vi.fn(), debug: vi.fn(), warning: vi.fn() }),
}))

// PR-2c step 8: the OAuth-on path now routes through `useBitrix24OAuth`
// which calls `useTokenStore()` and (on a fresh process) tries to
// `mkdir /data` for the SQLite DB. CI runners don't have /data write
// permission, so the test must mock the factory to keep the flag-on
// path off the real filesystem. The factory's behaviour is exhaustively
// covered by `tests/unit/utils/bitrix24-oauth.test.ts`; here we only
// need to assert that the catalogue surfaces the factory's error loud.
vi.mock('~/server/utils/bitrix24-oauth', () => ({
  useBitrix24OAuth: vi.fn(() => {
    throw new Error('oauth_tokens row missing for memberId=portal userId=1')
  }),
}))

const tool = (await import('../../../../server/mcp/tools/users/current-user')).default as {
  handler: (input: Record<string, never>) => Promise<unknown>
}

describe('b24_user_me', () => {
  beforeEach(() => {
    fake.v2Call.mockReset()
  })

  it('calls actions.v2.call.make with user.current and returns the shaped user payload', async () => {
    fake.v2Call.mockResolvedValue(
      fakeOk({
        ID: 1,
        NAME: 'Ada',
        LAST_NAME: 'Lovelace',
        // Fields the user.current REST surface does not reliably return
        // (EMAIL is scope-gated, ADMIN/SERVER_NAME are absent) — assert the
        // tool drops them rather than emitting misleading null/false values.
        EMAIL: 'SomeUser@example.com',
        ADMIN: true,
        SERVER_NAME: 'for-test.bitrix24.com',
      }),
    )

    const result = (await tool.handler({})) as {
      content: { type: 'text'; text: string }[]
    }

    expect(fake.v2Call).toHaveBeenCalledWith({ method: 'user.current', params: {} })
    const payload = JSON.parse(result.content[0]!.text)
    expect(payload).toEqual({
      id: 1,
      name: 'Ada',
      lastName: 'Lovelace',
    })
  })

  it('returns a friendly message when Bitrix24 has no result', async () => {
    fake.v2Call.mockResolvedValue(fakeOkEmpty())

    const result = (await tool.handler({})) as {
      content: { type: 'text'; text: string }[]
    }

    expect(result.content[0]!.text).toMatch(/no user/i)
  })

  it('wraps SDK errors into Bitrix24ToolError', async () => {
    fake.v2Call.mockRejectedValue(Object.assign(new Error('Unauthorized'), { code: 'UNAUTHORIZED' }))

    await expect(tool.handler({})).rejects.toMatchObject({
      name: 'Bitrix24ToolError',
      message: 'Unauthorized',
    })
  })

  // Cross-tenant leak guard at the catalogue level — round-2 review found
  // there was no tool-level assertion proving the dispatcher's loud-fail
  // contract; round-3 split the single regex-OR test into two so a future
  // regression that removes ONE of the two dispatcher guards (the "no
  // tenant scope" check or the "OAuth wiring pending" throw) is caught,
  // instead of being masked by the other branch matching the same regex.
  describe('NUXT_BITRIX24_OAUTH_ENABLED=true — loud fail, no silent webhook fallback', () => {
    // Save the original setup-file stub so `afterEach` restores it
    // verbatim. Re-stubbing with a new literal works today but would
    // drift silently if `tests/_setup.ts` adds another field.
    let originalRuntimeConfig: unknown
    beforeEach(() => {
      originalRuntimeConfig = (globalThis as { useRuntimeConfig?: unknown }).useRuntimeConfig
      vi.stubGlobal('useRuntimeConfig', () => ({ bitrix24OauthEnabled: true }))
    })
    afterEach(() => {
      vi.stubGlobal('useRuntimeConfig', originalRuntimeConfig)
    })

    it('without a tenant scope — throws "outside a tenant scope" (the wire-up bug branch)', async () => {
      // The MCP middleware (PR-2c) wraps requests in `runWithTenant`; if
      // it ever stops doing so while the flag is on, the dispatcher
      // refuses rather than silently routing to webhook (cross-tenant
      // leak class). This test pins that specific branch.
      await expect(tool.handler({})).rejects.toThrow('outside a tenant scope')
    })

    it('with a tenant scope but no oauth_tokens row — throws "row missing" from the factory', async () => {
      // The second loud-fail branch: tenant context resolves, but the
      // OAuth factory can't find a `oauth_tokens` row for the (memberId,
      // userId) pair. Test it in isolation so a future change to the
      // factory's error message can't accidentally pass the "outside a
      // tenant scope" test (the round-3 OR-regex risk).
      const { runWithTenant } = await import('../../../../server/utils/request-context')
      await expect(
        runWithTenant({ memberId: 'portal', userId: '1' }, () => tool.handler({})),
      ).rejects.toThrow(/row missing|requires NUXT_BITRIX24_OAUTH_CLIENT_ID/)
    })
  })
})
