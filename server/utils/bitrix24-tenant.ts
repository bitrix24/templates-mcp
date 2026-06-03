import type { TypeB24 } from '@bitrix24/b24jssdk'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { getTenantContext } from '~/server/utils/request-context'

/**
 * Tenant-aware Bitrix24 client dispatcher — the single seam every tool will
 * call once OAuth lands (PR-4 swaps `useBitrix24()` → `useBitrix24Tenant()`
 * across the tool catalogue).
 *
 * Behaviour depends on `NUXT_BITRIX24_OAUTH_ENABLED`:
 *
 *   - **OFF (default)** — returns the webhook singleton from
 *     {@link useBitrix24}. Byte-identical to today's behaviour. This is the
 *     escape hatch that keeps webhook-only forks working forever (§10 of
 *     `docs/OAUTH-DESIGN.md`: webhook stays as the dev / single-tenant /
 *     stdio fallback indefinitely).
 *
 *   - **ON** — reads the tenant from {@link getTenantContext} and resolves
 *     a per-tenant `B24OAuth` instance from the token store. **Not yet
 *     wired in PR-2a** — the OAuth-ON path throws a clear "wire-up pending"
 *     error so accidental enablement before PR-2c lands fails loud rather
 *     than silently routing through webhook. PR-2c replaces the throw with
 *     the real `useBitrix24OAuth(memberId, userId)` lookup.
 *
 * Return type is the SDK-exported {@link TypeB24} structural interface that
 * both `B24Hook` and `B24OAuth` implement (verified upstream in
 * `@bitrix24/b24jssdk` `dist/esm/index.d.ts` L2267-2361, L4533, L5314 —
 * `AbstractB24 implements TypeB24` is the shared base). Why not a
 * `B24Hook | B24OAuth` union or a local `B24Client` alias: `TypeB24`
 * already exists upstream and exposes exactly the surface tool helpers
 * touch (`actions.v2/v3.call/batch.make`, `auth`, `tools`, logger). A
 * union would force every helper to narrow at the boundary; a local alias
 * would drift from the SDK's own contract on the next bump. Closes #59 /
 * completes #63 — no upstream PR needed.
 *
 * Callers MUST NOT do `instanceof B24Hook` / `instanceof B24OAuth` checks —
 * the type is the contract. Tool helpers in `server/utils/sdk-helpers.ts`
 * take `b24: TypeB24` so they don't care which concrete class is underneath.
 */
export function useBitrix24Tenant(): TypeB24 {
  const { bitrix24OauthEnabled } = useRuntimeConfig()

  if (!bitrix24OauthEnabled) {
    return useBitrix24()
  }

  const tenant = getTenantContext()
  if (!tenant) {
    // OAuth is on but the request never ran through `runWithTenant` — this
    // is a wiring bug, not a user error. Refuse rather than silently
    // dropping to webhook (would be a cross-tenant leak class once PR-2c
    // adds the real OAuth path).
    throw new Error(
      'useBitrix24Tenant() called outside a tenant scope while '
      + 'NUXT_BITRIX24_OAUTH_ENABLED=true. Either turn the flag off (webhook '
      + 'fallback) or wire `runWithTenant({memberId, userId}, …)` in the MCP '
      + 'middleware (PR-2c).',
    )
  }

  // PR-2c replaces this with: return useBitrix24OAuth(tenant.memberId, tenant.userId)
  throw new Error(
    'useBitrix24Tenant() OAuth path is not yet implemented (lands in PR-2c). '
    + `Tenant context resolved to memberId=${tenant.memberId}, userId=${tenant.userId}, `
    + 'but no B24OAuth factory is wired. Keep NUXT_BITRIX24_OAUTH_ENABLED=false '
    + 'until PR-2c merges.',
  )
}
