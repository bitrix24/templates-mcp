import { describe, expect, it } from 'vitest'
import { getTenantContext, runWithTenant, tenantContext } from '../../../server/utils/request-context'

describe('request-context — AsyncLocalStorage tenant binding (PR-2a scaffold)', () => {
  it('getTenantContext returns undefined outside any runWithTenant scope', () => {
    expect(getTenantContext()).toBeUndefined()
  })

  it('runWithTenant binds the tenant for the awaited duration of fn', async () => {
    const ctx = { memberId: 'portal-a', userId: '42' }
    const observed = await runWithTenant(ctx, async () => getTenantContext())
    expect(observed).toEqual(ctx)
  })

  it('binding is gone after runWithTenant resolves', async () => {
    await runWithTenant({ memberId: 'p', userId: '1' }, async () => undefined)
    expect(getTenantContext()).toBeUndefined()
  })

  it('binding survives multiple `await` hops inside fn (microtask scheduler)', async () => {
    const ctx = { memberId: 'portal-async', userId: '99' }
    const observed = await runWithTenant(ctx, async () => {
      await Promise.resolve()
      await Promise.resolve()
      await new Promise<void>(resolve => setImmediate(resolve))
      return getTenantContext()
    })
    expect(observed).toEqual(ctx)
  })

  it('two concurrent runWithTenant scopes each see their own context (no cross-tenant leak)', async () => {
    // The PR-2 design depends on per-request ALS isolation — duplicating
    // the cross-tenant leak guard from tests/unit/als-propagation.test.ts
    // (#60) here so the tenant helper itself is regression-pinned, not
    // just the underlying transport.
    const a = runWithTenant({ memberId: 'portal-A', userId: '1' }, async () => {
      await new Promise<void>(resolve => setImmediate(resolve))
      return getTenantContext()
    })
    const b = runWithTenant({ memberId: 'portal-B', userId: '2' }, async () => {
      await Promise.resolve()
      return getTenantContext()
    })
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toEqual({ memberId: 'portal-A', userId: '1' })
    expect(rb).toEqual({ memberId: 'portal-B', userId: '2' })
  })

  it('the exported ALS instance is the SAME store getTenantContext / runWithTenant operate on', async () => {
    // The `tenantContext` export is `@internal` — only middleware (PR-2c)
    // imports it. To prove the contract without poking at the export the
    // way production code shouldn't: write through `runWithTenant`, read
    // through `getTenantContext`, AND read through the raw export — all
    // three must agree. If a refactor accidentally created two ALS
    // instances (e.g. dual-import via a circular path), `runWithTenant`
    // would write to one and `tenantContext.getStore()` would see the
    // OTHER store as undefined, surfacing here.
    const ctx = { memberId: 'shared-store', userId: '7' }
    const observed = await runWithTenant(ctx, async () => ({
      viaHelper: getTenantContext(),
      viaRawExport: tenantContext.getStore(),
    }))
    expect(observed.viaHelper).toEqual(ctx)
    expect(observed.viaRawExport).toEqual(ctx)
    expect(observed.viaHelper).toBe(observed.viaRawExport)
  })

  it('throw inside fn propagates out and the ALS scope is still cleaned up after', async () => {
    // The middleware (PR-2c) will catch errors from `next()` to translate
    // them into HTTP responses. If a thrown error inside `runWithTenant`
    // ever leaked the tenant scope into subsequent unrelated work in the
    // same process — that would be a cross-tenant leak class. Native
    // AsyncLocalStorage gives us this for free, but pinning it here
    // protects against a future wrapper that wraps `tenantContext.run` in
    // a try/finally and forgets to re-throw or to exit the scope.
    await expect(
      runWithTenant({ memberId: 'p', userId: '1' }, async () => {
        throw new Error('handler-boom')
      }),
    ).rejects.toThrow('handler-boom')
    expect(getTenantContext()).toBeUndefined()
  })

  it('accepts a sync fn — type-level compat for PR-2c middleware wiring', async () => {
    // The toolkit's `next()` is async today, but PR-2c may want to wrap a
    // sync helper before awaiting. `runWithTenant` is overloaded so a sync
    // `fn` returns the raw `T` (not `T | Promise<T>`, which would force
    // every call site to add `await` or a cast).
    const result = runWithTenant({ memberId: 'sync', userId: '0' }, () => 'sync-result' as const)
    expect(result).toBe('sync-result')
    expect(getTenantContext()).toBeUndefined()
  })

  it('multiple getTenantContext() reads inside one scope return the same identity', async () => {
    // The tenant object is captured once by `tenantContext.run`; every
    // `getStore()` call returns the SAME reference. If a future wrapper
    // started cloning / freezing / wrapping the store on read, this test
    // catches it before downstream code that compares tenants by identity
    // (e.g. PR-2c's per-tenant `B24OAuth` LRU keyed on the store object)
    // silently breaks.
    const ctx = { memberId: 'identity', userId: '1' }
    const [first, second, third] = await runWithTenant(ctx, async () => [
      getTenantContext(),
      getTenantContext(),
      getTenantContext(),
    ])
    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(first).toBe(ctx) // same ref as the one passed to runWithTenant
  })
})
