import type { TypeB24 } from '@bitrix24/b24jssdk'
import { useBitrix24 } from '~/server/utils/bitrix24'
import { useBitrix24OAuth } from '~/server/utils/bitrix24-oauth'
import { useLogger } from '~/server/utils/logger'
import { getTenantContext } from '~/server/utils/request-context'

/**
 * Tenant-aware Bitrix24 client dispatcher — the single seam every tool
 * calls. PR-2d swapped every tool from `useBitrix24()` to this dispatcher;
 * PR-2c (this commit) wires the OAuth-on branch to the real `B24OAuth`
 * factory.
 *
 * Behaviour depends on `NUXT_BITRIX24_OAUTH_ENABLED`:
 *
 *   - **OFF (default)** — returns the webhook singleton from
 *     {@link useBitrix24}. Byte-identical to today's behaviour. This is
 *     the escape hatch that keeps webhook-only forks working forever
 *     (§10: webhook stays as the dev / single-tenant / stdio fallback
 *     indefinitely).
 *
 *   - **ON** — reads the tenant from {@link getTenantContext} and
 *     resolves a per-tenant `B24OAuth` instance from the in-memory LRU
 *     (`useBitrix24OAuth`). The instance handles refresh-on-expiry via
 *     its custom refresh callback; tools see a uniform `TypeB24` shape
 *     regardless of which underlying class powers it.
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
    // OAuth is on but the request never ran through `runWithTenant` —
    // this is a wiring bug (Bearer middleware didn't fire, or a tool was
    // invoked outside the MCP request lifecycle). Refuse rather than
    // silently dropping to webhook (cross-tenant leak class). The agent
    // sees the generic error message; the operator gets the diagnosis
    // through the structured logger.
    useLogger().error('oauth.tenant.dispatch.no-tenant-scope', {
      reason: 'useBitrix24Tenant called outside a runWithTenant scope while OAuth is enabled',
    })
    throw new Error(
      'useBitrix24Tenant() called outside a tenant scope while '
      + 'NUXT_BITRIX24_OAUTH_ENABLED=true. Either turn the flag off (webhook '
      + 'fallback) or wire `runWithTenant({memberId, userId, requestId}, …)` '
      + 'in the MCP middleware.',
    )
  }

  // PR-2c wires the real per-tenant client. `tenant.userId` comes from
  // the ALS as a string (the `TenantContext` interface stores it as a
  // stringified Bitrix24 user id — matches the audit-log shape); the
  // factory expects a number, so coerce here. NaN can't happen in
  // practice (the middleware constructs `TenantContext` from a verified
  // `findByBearerHash` lookup that originated from a `oauth_tokens` row
  // with a numeric `user_id` column), but we throw loud if it does.
  const userIdNum = Number.parseInt(tenant.userId, 10)
  if (!Number.isFinite(userIdNum)) {
    useLogger().error('oauth.tenant.dispatch.bad-user-id', { userId: tenant.userId })
    throw new Error(`useBitrix24Tenant: tenant.userId is not a valid integer (got ${JSON.stringify(tenant.userId)})`)
  }
  return useBitrix24OAuth(tenant.memberId, userIdNum)
}
