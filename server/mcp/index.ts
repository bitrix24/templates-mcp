import { createHash, randomBytes } from 'node:crypto'
import { createError, getHeader, setResponseHeader } from 'h3'
import { defineMcpHandler } from '@nuxtjs/mcp-toolkit/server'
import { useLogger } from '~/server/utils/logger'
import { runWithTenant } from '~/server/utils/request-context'
import { useTokenStore } from '~/server/utils/token-store'

/**
 * MCP handler override (issue #217) — the last wire that makes a minted
 * OAuth Bearer actually authenticate on `/mcp`.
 *
 * Architecture:
 *   - When `NUXT_BITRIX24_OAUTH_ENABLED=false` (the production default)
 *     the toolkit-level `middleware` here is a no-op pass-through. The
 *     h3-level `server/middleware/mcp-auth.ts` handles auth against
 *     `NUXT_MCP_AUTH_TOKEN` exactly as today — webhook-only forks see
 *     zero behaviour change.
 *
 *   - When `=true`, the h3 middleware yields (see its short-circuit) and
 *     THIS middleware owns auth. It extracts the `Authorization: Bearer`
 *     header, hashes the value (sha256), and resolves it via
 *     {@link useTokenStore}.`inspectBearer` so the §11 taxonomy can
 *     distinguish three deny states:
 *       - `mcp.auth.deny.bearer-unknown`  — no `mcp_tokens` row at all
 *       - `mcp.auth.deny.bearer-revoked`  — row exists with `revoked_at`
 *       - `mcp.auth.deny.bearer-orphan`   — Bearer alive but the
 *           parent `oauth_tokens` row was deleted (CASCADE should make
 *           this impossible, but we log defensively per §11)
 *
 *     On the happy path we generate a fresh 16-byte hex `requestId` and
 *     wrap `next()` in `runWithTenant({memberId, userId, requestId}, …)`.
 *     The Nuxt MCP toolkit's tool-dispatch chain is plain `await next()`
 *     (verified in PR-2a's ALS spike, issue #60), so the tenant context
 *     propagates through to every tool's `useBitrix24Tenant()` call.
 *
 * Why the toolkit `middleware` and not h3-only:
 *   h3 middleware can THROW or CONTINUE, but it cannot ENCLOSE the rest
 *   of the request in an AsyncLocalStorage scope. The toolkit's
 *   `middleware: (event, next) => …` is the documented seam that lets
 *   us call `runWithTenant(..., () => next())` and have the binding
 *   visible inside every tool handler.
 *
 * Failure-mode invariants (§11):
 *   - Every 401 carries a `WWW-Authenticate: Bearer error="…", errorCode="…"`
 *     header so the user pasting the error into Slack and the operator
 *     greping the JSONL log find the same string.
 *   - The raw Bearer NEVER appears in any log line — only the hash
 *     prefix (`sha256-<8 hex>`).
 *   - On orphan we log the tenant identifiers through the structured
 *     logger (operator-visible) but the 401 body stays generic.
 */

const BEARER_RE = /^Bearer\s+(.+)$/i

interface DenyOptions {
  errorCode: string
  statusMessage: string
}

function denyBearer(opts: DenyOptions): never {
  throw createError({
    statusCode: 401,
    statusMessage: opts.statusMessage,
    data: { errorCode: opts.errorCode },
  })
}

/**
 * Build a `WWW-Authenticate: Bearer …` header value per RFC 6750 §3.
 * `error="invalid_token"` keeps the standard-compliant slot; `errorCode`
 * is the §11 taxonomy suffix so the operator can grep the exact string
 * the user pasted into Slack.
 *
 * Both `code` and `description` are interpolated into a quoted-string
 * production (`token = quoted-string` in RFC 7230 §3.2.6). We escape
 * embedded `\` and `"` defensively — current call sites pass string
 * literals (so escaping is a no-op today), but a future refactor that
 * threads a Bitrix24-controlled value into `description` shouldn't be
 * able to inject extra header attributes.
 */
function wwwAuthHeader(code: string, description: string): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `Bearer error="invalid_token", errorCode="${esc(code)}", error_description="${esc(description)}"`
}

export default defineMcpHandler({
  middleware: async (event, next) => {
    const { bitrix24OauthEnabled } = useRuntimeConfig()
    if (!bitrix24OauthEnabled) return next()

    const logger = useLogger()
    const header = getHeader(event, 'authorization') ?? ''
    const match = header.match(BEARER_RE)
    const token = match?.[1]?.trim()

    if (!token) {
      // No Bearer at all → 401 with the same taxonomy bucket as
      // `bearer-unknown` (an absent Bearer is indistinguishable from
      // one that's never been minted). The WWW-Authenticate header
      // tells a well-behaved client to prompt for a token. `return
      // denyBearer(...)` narrows `token` to `string` below without a
      // non-null assertion (denyBearer's return type is `never`).
      void logger.warning('mcp.auth.deny.bearer-unknown', { reason: 'no-bearer' })
      setResponseHeader(event, 'www-authenticate', wwwAuthHeader('BEARER-UNKNOWN', 'Bearer required'))
      return denyBearer({ errorCode: 'BEARER-UNKNOWN', statusMessage: 'Bearer required' })
    }

    const bearerHash = `sha256-${createHash('sha256').update(token).digest('hex')}`
    const bearerHashPrefix = bearerHash.slice(0, 15) // 'sha256-' + 8 hex
    const store = useTokenStore()
    const inspection = store.inspectBearer(bearerHash)

    if (!inspection) {
      void logger.warning('mcp.auth.deny.bearer-unknown', { bearerHashPrefix })
      setResponseHeader(event, 'www-authenticate', wwwAuthHeader('BEARER-UNKNOWN', 'Bearer not recognised'))
      return denyBearer({ errorCode: 'BEARER-UNKNOWN', statusMessage: 'Bearer not recognised' })
    }

    if (inspection.revokedAt !== null) {
      void logger.warning('mcp.auth.deny.bearer-revoked', {
        bearerHashPrefix,
        memberId: inspection.memberId,
        userId: inspection.userId,
        revokedAt: inspection.revokedAt,
      })
      setResponseHeader(event, 'www-authenticate', wwwAuthHeader('BEARER-REVOKED', 'Bearer revoked'))
      return denyBearer({ errorCode: 'BEARER-REVOKED', statusMessage: 'Bearer revoked - re-authorise at /api/oauth/install' })
    }

    // Orphan check — `mcp_tokens` row exists and is active, but the
    // parent `oauth_tokens` row was deleted out from under it. The
    // CASCADE constraint should prevent this, but a manual SQLite
    // operator-edit could create the state. Log loud, refuse.
    const tenantStillExists = store.getTokens(inspection.memberId, inspection.userId) !== undefined
    if (!tenantStillExists) {
      void logger.error('mcp.auth.deny.bearer-orphan', {
        bearerHashPrefix,
        memberId: inspection.memberId,
        userId: inspection.userId,
      })
      setResponseHeader(event, 'www-authenticate', wwwAuthHeader('BEARER-ORPHAN', 'Bearer orphan - re-authorise at /api/oauth/install'))
      return denyBearer({ errorCode: 'BEARER-ORPHAN', statusMessage: 'Bearer orphan - tenant missing' })
    }

    // Happy path: mint a per-request correlation id and wrap the rest
    // of the request in the tenant ALS scope. Every `oauth.*` and
    // tool-side log line emitted inside `next()` now carries the same
    // `requestId` (via `getRequestId()`), so one `jq` query reconstructs
    // the whole timeline.
    const requestId = randomBytes(16).toString('hex')
    void logger.info('mcp.auth.ok', {
      memberId: inspection.memberId,
      userId: inspection.userId,
      bearerHashPrefix,
      requestId,
    })

    return runWithTenant(
      {
        memberId: inspection.memberId,
        // TenantContext.userId is typed as string (PR-2a — matches the
        // audit-log shape that prefers stable string ids). The dispatcher
        // (PR-2d) re-parses it to number for the factory; the round-trip
        // costs one String() + one parseInt() per request.
        userId: String(inspection.userId),
        requestId,
      },
      () => next(),
    )
  },
})
