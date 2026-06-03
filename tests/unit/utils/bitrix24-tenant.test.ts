import type { B24Hook } from '@bitrix24/b24jssdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ContextModule from '../../../server/utils/request-context'
import type * as TenantModule from '../../../server/utils/bitrix24-tenant'

// Stand-in for the webhook singleton — `useBitrix24` from
// server/utils/bitrix24.ts is mocked to return this object so the dispatcher
// can be exercised without booting the real SDK.
const webhookSingleton = Symbol('webhook-client') as unknown as B24Hook

const useBitrix24 = vi.fn(() => webhookSingleton)
vi.mock('~/server/utils/bitrix24', () => ({ useBitrix24 }))

const runtimeConfig: { bitrix24OauthEnabled: boolean } = { bitrix24OauthEnabled: false }
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

async function loadFresh(): Promise<{
  tenant: typeof TenantModule
  ctx: typeof ContextModule
}> {
  // Both modules must come from the SAME `vi.resetModules()` cache so the
  // AsyncLocalStorage instance the dispatcher reads is the SAME one
  // `runWithTenant` writes to. Importing them separately at file scope
  // produces two ALS instances with disjoint stores.
  vi.resetModules()
  const tenant = await import('../../../server/utils/bitrix24-tenant')
  const ctx = await import('../../../server/utils/request-context')
  return { tenant, ctx }
}

describe('useBitrix24Tenant — flag-gated dispatcher (PR-2a scaffold)', () => {
  beforeEach(() => {
    useBitrix24.mockClear()
    runtimeConfig.bitrix24OauthEnabled = false
  })

  describe('NUXT_BITRIX24_OAUTH_ENABLED=false (webhook-only forks)', () => {
    it('returns the webhook singleton — byte-identical to today', async () => {
      const { tenant: { useBitrix24Tenant } } = await loadFresh()
      expect(useBitrix24Tenant()).toBe(webhookSingleton)
      expect(useBitrix24).toHaveBeenCalledTimes(1)
    })

    it('does NOT consult the tenant context (no ALS read when OAuth off)', async () => {
      // Even if a stray ALS scope somehow wrapped this call, the dispatcher
      // must ignore it under flag=false — otherwise a future bug that leaks
      // an OAuth tenant into a webhook-only request path would route to
      // OAuth and crash.
      const { tenant: { useBitrix24Tenant }, ctx: { runWithTenant } } = await loadFresh()
      const result = await runWithTenant(
        { memberId: 'should-be-ignored', userId: '999' },
        async () => useBitrix24Tenant(),
      )
      expect(result).toBe(webhookSingleton)
    })
  })

  describe('NUXT_BITRIX24_OAUTH_ENABLED=true (OAuth wiring landing in PR-2c)', () => {
    beforeEach(() => {
      runtimeConfig.bitrix24OauthEnabled = true
    })

    it('throws clearly when no tenant context is bound (wiring bug)', async () => {
      const { tenant: { useBitrix24Tenant } } = await loadFresh()
      expect(() => useBitrix24Tenant()).toThrow(/outside a tenant scope/)
      expect(useBitrix24).not.toHaveBeenCalled()
    })

    it('throws "OAuth path not implemented" when a tenant IS bound (PR-2c stub)', async () => {
      const { tenant: { useBitrix24Tenant }, ctx: { runWithTenant } } = await loadFresh()
      await expect(
        runWithTenant({ memberId: 'p', userId: '1' }, async () => useBitrix24Tenant()),
      ).rejects.toThrow(/not yet implemented \(lands in PR-2c\)/)
    })

    it('refuses to fall back to webhook when OAuth is on (no silent cross-tenant leak)', async () => {
      const { tenant: { useBitrix24Tenant } } = await loadFresh()
      // The dispatcher MUST NOT call useBitrix24() under flag=true; the
      // whole point of the flag is to keep the two transports separate.
      try {
        useBitrix24Tenant()
      } catch {
        // expected — see throw test above
      }
      expect(useBitrix24).not.toHaveBeenCalled()
    })
  })
})
