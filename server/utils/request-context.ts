import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-request tenant context for the multi-tenant OAuth surface — the seam
 * between `defineMcpHandler`'s `middleware` hook and the tool handlers it
 * dispatches into.
 *
 * Why ALS (not h3 `event.context`):
 *   `@nuxtjs/mcp-toolkit`'s `defineMcpTool` handler signature is
 *   `async ({ input }) => …` — the h3 event is NOT passed through. The
 *   toolkit's `middleware` → `next()` → handler chain is plain `await`
 *   (verified in `@nuxtjs/mcp-toolkit@0.17 dist/runtime/server/mcp/utils.js`
 *   L191-209, and confirmed empirically by `tests/unit/als-propagation.test.ts`
 *   from issue #60 — landed via PR #64). Stashing tenant on `event.context`
 *   would require forking the toolkit; ALS doesn't.
 *
 * Why a module-level singleton AsyncLocalStorage:
 *   Node's contract is that an ALS instance is process-wide and binds via
 *   its own .run() call — multiple ALS instances cannot bleed into each
 *   other. The instance is exported (marked `@internal`) only so the OAuth
 *   middleware (PR-2c) and `useBitrix24Tenant()` (here, via
 *   `getTenantContext`) read/write the SAME store. Production tool code
 *   MUST go through {@link runWithTenant} / {@link getTenantContext} so a
 *   future trace/metrics wrapper around `runWithTenant` is never bypassed.
 *
 * Dev-only caveat (HMR): in a Vite/Nitro dev server with hot-module
 * reloading, this file may be re-evaluated independently of the middleware
 * file (PR-2c). When that happens, two ALS instances exist briefly —
 * middleware writes to one, dispatcher reads from the other, and
 * `getTenantContext()` returns `undefined` until both files reload
 * together. Workaround: full dev-server restart. Production (Nitro
 * build → single process load) is not affected.
 *
 * Lifecycle:
 *   1. Middleware reads Bearer → looks up `(memberId, userId)` from token
 *      store → calls `runWithTenant({memberId, userId}, () => next())`.
 *   2. Inside the resulting promise tree, every tool handler that resolves
 *      its client via `useBitrix24Tenant()` (PR-2a; OAuth wiring lands in
 *      PR-2c) reads the tenant via `getTenantContext()`.
 *   3. When `NUXT_BITRIX24_OAUTH_ENABLED=false`, the middleware does NOT
 *      run the wrap, the store stays `undefined`, and the tenant dispatcher
 *      falls back to the webhook singleton — zero behaviour change for
 *      existing forks.
 *
 * Scope: PR-2a (this file) introduces the store and helpers only. The
 * actual middleware wrap + token-store lookup lands in PR-2c.
 */

/** Tenant identity for the multi-tenant OAuth surface. */
export interface TenantContext {
  /** Bitrix24 `member_id` — opaque portal identifier from the OAuth payload. */
  readonly memberId: string
  /** Bitrix24 user id (`access_token` owner). */
  readonly userId: string
  /**
   * Per-request correlation id (16-byte hex) — populated by the MCP
   * middleware in PR-2c so every OAuth log line in one request shares a
   * `requestId` (see `docs/OAUTH-DESIGN.md §11`). Optional in this
   * interface so PR-2a callers that pass only `{memberId, userId}` stay
   * valid; PR-2c will set the field unconditionally inside the middleware
   * wrap, and `useBitrix24Tenant()` reads it through `getTenantContext()`
   * without needing a separate ALS payload. Marking it optional up front
   * means PR-2c doesn't have to touch every test that constructs a
   * `TenantContext` object literal.
   */
  readonly requestId?: string
}

/**
 * Process-wide ALS instance.
 *
 * @internal Exported only so the OAuth middleware (PR-2c) and this module's
 *   own helpers share a single store. Production tool code MUST use
 *   {@link runWithTenant} / {@link getTenantContext}, NOT call `.run` or
 *   `.getStore` on this export directly — a future tracing/metrics wrapper
 *   around `runWithTenant` would be silently bypassed otherwise. Tests
 *   should drive the contract through `runWithTenant` for the same reason.
 */
export const tenantContext = new AsyncLocalStorage<TenantContext>()

/**
 * Runs `fn` inside a tenant scope. The middleware (PR-2c) wraps every OAuth
 * request with this; tests use it to drive deterministic tenant binding.
 *
 * `fn` can be sync or async — the toolkit's `next()` returns whatever the
 * caller returns, so a wrapper that wants to pass sync work through (e.g.
 * `runWithTenant(ctx, () => next())` where the toolkit hasn't decided to
 * make `next` awaitable yet) shouldn't have to wrap with `async`. Native
 * `AsyncLocalStorage.run` accepts either shape; we expose proper overloads
 * so a sync caller gets `T` back (not `T | Promise<T>`, which would force
 * an `await` or a cast even on the sync path).
 */
export function runWithTenant<T>(ctx: TenantContext, fn: () => Promise<T>): Promise<T>
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T
export function runWithTenant<T>(ctx: TenantContext, fn: () => T | Promise<T>): T | Promise<T> {
  return tenantContext.run(ctx, fn)
}

/**
 * Returns the tenant bound to the current async scope, or `undefined` when
 * called outside any `runWithTenant` (typical for webhook-only forks where
 * the middleware never runs the wrap).
 */
export function getTenantContext(): TenantContext | undefined {
  return tenantContext.getStore()
}

/**
 * Returns the `requestId` bound to the current async scope. **Throws** when
 * called outside a `runWithTenant` wrap OR when the wrap forgot to set
 * `requestId` — that's a wire-up bug, not a runtime condition callers
 * should branch on. Issue #214 (PR-2c precondition): the MCP middleware
 * populates `requestId` unconditionally for every request, so a throw
 * here is "middleware not wired" or "test fixture passed a partial
 * context", never a happy-path 401.
 *
 * Callers (the upcoming `oauth.*` and `mcp.auth.*` log emitters) MUST
 * use this helper instead of reading `getTenantContext()?.requestId`
 * directly — a missing field then becomes a loud failure at the first
 * log line, not a silent gap downstream where a `jq` query returns
 * nothing for events that should have shared a correlation id.
 *
 * @throws {Error} When called outside a `runWithTenant` scope, or when
 *   `runWithTenant` was called without a `requestId` in the context.
 */
export function getRequestId(): string {
  const ctx = tenantContext.getStore()
  if (!ctx?.requestId) {
    throw new Error(
      'getRequestId() called outside a runWithTenant scope, or runWithTenant was '
      + 'called without a requestId. The MCP middleware (PR-2c) must wrap every '
      + 'request with `runWithTenant({memberId, userId, requestId}, …)`. '
      + 'See docs/OAUTH-DESIGN.md §11 and issue #214.',
    )
  }
  return ctx.requestId
}
