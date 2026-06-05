/**
 * Tests for the `useBitrix24Tenant()` flag-gated dispatcher (PR-2a scaffold,
 * design in `docs/OAUTH-DESIGN.md` §7 / §10).
 *
 * **Depends on `server/utils/request-context.ts`** — the dispatcher reads
 * its tenant from the ALS singleton exported there. The `loadFresh()`
 * helper resets the module cache per test so both modules come from the
 * SAME `vi.resetModules()` iteration; without that, the dispatcher would
 * read from one ALS instance while `runWithTenant` writes to another and
 * the tenant always reads `undefined`. The two `await import(…)` calls in
 * `loadFresh()` MUST stay sequential (not `Promise.all`) — a parallel
 * import could land each module in a separate module-resolution batch and
 * defeat the shared-cache invariant.
 *
 * `webhookSingleton` is a `Symbol` cast to `B24Hook`: we only need identity
 * comparison (`toBe`) to prove the dispatcher returns the singleton the
 * mocked `useBitrix24` produced. A `Symbol` makes accidental property
 * access on the stand-in throw loudly.
 */
import type { B24Hook } from '@bitrix24/b24jssdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ContextModule from '../../../server/utils/request-context'
import type * as TenantModule from '../../../server/utils/bitrix24-tenant'

// Stand-in for the webhook singleton — `useBitrix24` from
// server/utils/bitrix24.ts is mocked to return this object so the dispatcher
// can be exercised without booting the real SDK.
const webhookSingleton = Symbol('webhook-client') as unknown as B24Hook

const useBitrix24 = vi.fn(() => webhookSingleton)
vi.mock('~/server/utils/bitrix24', () => ({ useBitrix24 }))

// PR-2c step 8: the OAuth-on branch now calls `useBitrix24OAuth`. The
// test mocks the factory so the dispatcher's tenant→client resolution is
// driven by a controllable return value (no need to seed a real SQLite
// store + B24OAuth instance from inside the dispatcher's unit test).
const oauthClient = Symbol('oauth-client') as unknown as B24Hook
const useBitrix24OAuth = vi.fn((_memberId: string, _userId: number) => oauthClient)
vi.mock('~/server/utils/bitrix24-oauth', () => ({ useBitrix24OAuth }))

// Logger mock — the dispatcher uses the structured logger to surface the
// tenant identifiers operator-side without leaking them into the thrown
// Error message (which the MCP toolkit forwards to the agent). Tests
// assert against `loggerError.mock.calls` to verify the tenant landed on
// the operator-visible channel.
const loggerError = vi.fn()
vi.mock('~/server/utils/logger', () => ({
  useLogger: () => ({ error: loggerError, info: vi.fn(), debug: vi.fn(), warning: vi.fn() }),
}))

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
    loggerError.mockClear()
    runtimeConfig.bitrix24OauthEnabled = false
  })

  describe('NUXT_BITRIX24_OAUTH_ENABLED=false (webhook-only forks)', () => {
    it('returns the webhook singleton — byte-identical to today', async () => {
      const { tenant: { useBitrix24Tenant } } = await loadFresh()
      expect(useBitrix24Tenant()).toBe(webhookSingleton)
      expect(useBitrix24).toHaveBeenCalledTimes(1)
    })

    it('returns the same client across N repeated calls (singleton contract)', async () => {
      // PR-4d will swap useBitrix24() → useBitrix24Tenant() across 23
      // tools that each call it many times per request. The webhook
      // singleton lives in useBitrix24 itself; the dispatcher's
      // responsibility is to never *swap* the returned identity under
      // a fixed flag value. Pinning that here so a future "cache by
      // tenant" refactor that breaks identity for the webhook-only path
      // fails loud.
      const { tenant: { useBitrix24Tenant } } = await loadFresh()
      const results = Array.from({ length: 100 }, () => useBitrix24Tenant())
      expect(new Set(results).size).toBe(1)
      expect(results[0]).toBe(webhookSingleton)
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

    it('two concurrent OFF requests under different ALS scopes share the same singleton', async () => {
      // Symmetric to the "two concurrent OAuth-ON" test below. When OAuth
      // is OFF, the dispatcher returns the webhook singleton REGARDLESS of
      // whether the request happens to be wrapped in an ALS scope (e.g.
      // because a future middleware bug always wraps). Pinning this
      // catches a refactor that adds a "if tenant present, route to OAuth
      // even when flag is off" shortcut.
      const { tenant: { useBitrix24Tenant }, ctx: { runWithTenant } } = await loadFresh()
      const [a, b] = await Promise.all([
        runWithTenant({ memberId: 'portal-A', userId: '1' }, async () => useBitrix24Tenant()),
        runWithTenant({ memberId: 'portal-B', userId: '2' }, async () => useBitrix24Tenant()),
      ])
      expect(a).toBe(webhookSingleton)
      expect(b).toBe(webhookSingleton)
      expect(a).toBe(b)
    })
  })

  describe('NUXT_BITRIX24_OAUTH_ENABLED=true (OAuth wiring landing in PR-2c)', () => {
    beforeEach(() => {
      runtimeConfig.bitrix24OauthEnabled = true
    })

    afterEach(() => {
      // Reset to the outer-describe default explicitly — if a future test
      // is added BETWEEN the two `describe` blocks (or outside both), it
      // would otherwise inherit `true` and behave unexpectedly. Belt and
      // braces alongside the outer `beforeEach` reset.
      runtimeConfig.bitrix24OauthEnabled = false
    })

    it('throws clearly when no tenant context is bound — and the error names the flag the operator must flip', async () => {
      const { tenant: { useBitrix24Tenant } } = await loadFresh()
      // Pin both halves of the diagnostic: WHAT went wrong and HOW to
      // recover. Reverting either half silently degrades the operator
      // experience without breaking the test, hence two regex assertions.
      expect(() => useBitrix24Tenant()).toThrow(/outside a tenant scope/)
      expect(() => useBitrix24Tenant()).toThrow(/NUXT_BITRIX24_OAUTH_ENABLED/)
      expect(useBitrix24).not.toHaveBeenCalled()
      expect(useBitrix24OAuth).not.toHaveBeenCalled()
    })

    it('calls useBitrix24OAuth(memberId, userId) with a tenant bound, returns the factory result', async () => {
      // PR-2c step 8: the dispatcher now wires the factory. The test
      // asserts: (a) the factory is invoked with the resolved tenant,
      // and (b) the dispatcher returns whatever the factory returned.
      // Tenant id resolution: TenantContext stores `userId` as a string,
      // the factory expects a number — the dispatcher does the coerce.
      useBitrix24OAuth.mockClear()
      const { tenant: { useBitrix24Tenant }, ctx: { runWithTenant } } = await loadFresh()
      const tenant = { memberId: 'portal-value', userId: '42' }
      const observed = await runWithTenant(tenant, async () => useBitrix24Tenant())
      expect(observed).toBe(oauthClient)
      expect(useBitrix24OAuth).toHaveBeenCalledWith('portal-value', 42)
      expect(useBitrix24).not.toHaveBeenCalled() // webhook path NEVER reached
    })

    it('refuses a non-numeric tenant.userId (defensive — the middleware should never produce one)', async () => {
      const { tenant: { useBitrix24Tenant }, ctx: { runWithTenant } } = await loadFresh()
      const tenant = { memberId: 'portal', userId: 'not-a-number' }
      await expect(
        runWithTenant(tenant, async () => useBitrix24Tenant()),
      ).rejects.toThrow(/not a valid integer/)
      // Operator log carries the bad userId for diagnosis.
      expect(loggerError).toHaveBeenCalledWith(
        'oauth.tenant.dispatch.bad-user-id',
        expect.objectContaining({ userId: 'not-a-number' }),
      )
    })

    it('N=10 concurrent OAuth-ON requests each resolve to the SAME factory call (cross-tenant leak guard)', async () => {
      // Cross-tenant invariant: each `runWithTenant` scope reaches the
      // factory with its OWN tenant. The factory mock asserts on the
      // arguments — if ALS leaked between scopes, the arg pair wouldn't
      // match the expected (memberId, userId) for that index.
      useBitrix24OAuth.mockClear()
      const { tenant: { useBitrix24Tenant }, ctx: { runWithTenant } } = await loadFresh()
      const tenants = Array.from({ length: 10 }, (_, i) => ({
        memberId: `portal-${i}`,
        userId: String(i),
      }))
      await Promise.all(
        tenants.map(t => runWithTenant(t, async () => useBitrix24Tenant())),
      )
      expect(useBitrix24OAuth).toHaveBeenCalledTimes(10)
      // Bijection guard: each input tenant appears as exactly one
      // factory call argument pair.
      const seenPairs = new Set(
        useBitrix24OAuth.mock.calls.map(c => `${c[0]}:${c[1]}`),
      )
      expect(seenPairs.size).toBe(10)
      tenants.forEach((t) => {
        expect(seenPairs.has(`${t.memberId}:${Number(t.userId)}`)).toBe(true)
      })
    })

    it('nested runWithTenant — inner scope wins, restored to outer on resolve (PR-2c middleware-order guard)', async () => {
      // Native ALS semantics: an inner `tenantContext.run(...)` creates a
      // child scope that shadows the outer one for its duration, and the
      // outer scope is restored when the inner resolves. PR-2c's middleware
      // must NEVER call `runWithTenant` inside another active scope (that
      // would silently swap the tenant for the rest of the request), but
      // until the lint/runtime guard for that lands the semantics need to
      // be pinned so a future bug surfaces here, not in production.
      const { ctx: { runWithTenant, getTenantContext } } = await loadFresh()
      const observed = await runWithTenant({ memberId: 'outer', userId: '1' }, async () => {
        const beforeInner = getTenantContext()
        const fromInner = await runWithTenant({ memberId: 'inner', userId: '2' }, async () =>
          getTenantContext(),
        )
        const afterInner = getTenantContext()
        return { beforeInner, fromInner, afterInner }
      })
      expect(observed.beforeInner?.memberId).toBe('outer')
      expect(observed.fromInner?.memberId).toBe('inner')
      expect(observed.afterInner?.memberId).toBe('outer')
    })

    it('refuses to fall back to webhook when OAuth is on (no silent cross-tenant leak)', async () => {
      const { tenant: { useBitrix24Tenant } } = await loadFresh()
      // Replaces an earlier `try/catch {}` that would have swallowed an
      // unrelated error (e.g. ReferenceError from a sloppy refactor) and
      // still passed the `useBitrix24 not called` assertion. The explicit
      // regex pins it to the expected branch.
      expect(() => useBitrix24Tenant()).toThrow(/outside a tenant scope/)
      expect(useBitrix24).not.toHaveBeenCalled()
    })
  })
})
