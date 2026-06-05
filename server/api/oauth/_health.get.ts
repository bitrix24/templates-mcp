import { Buffer } from 'node:buffer'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'
import { createError, defineEventHandler, getHeader, getRequestIP } from 'h3'
import { useLogger } from '~/server/utils/logger'
import { useTokenStore } from '~/server/utils/token-store'

/**
 * Operator-tier OAuth health endpoint (`docs/OAUTH-DESIGN.md §11`).
 *
 * Returns counts ONLY — no PII, no tokens, no portal hosts. The endpoint
 * is the readiness target for orchestrators (`kubelet`, `docker-compose
 * healthcheck`) and the first place an operator looks when "Bearer
 * doesn't work" support tickets show up:
 *
 *   GET /api/oauth/_health   →  200 { enabled, tenants, bearers, pendingStates, lastRefreshOk, lastRefreshFail }
 *
 * The route is **fails-closed by default** — without one of the two
 * acceptable authentication patterns it returns 503, never 200:
 *
 *   1. Network-level isolation (recommended): the request originates
 *      from localhost (`127.0.0.1` / `::1`). This is what nginx +
 *      `proxy_pass` looks like from inside the container, and what the
 *      reference docker-compose setup uses. An operator-only nginx
 *      `location /api/oauth/_health` block with `allow <ops-cidr>; deny
 *      all;` controls who reaches the route.
 *
 *   2. Dedicated admin token: `NUXT_BITRIX24_OAUTH_ADMIN_TOKEN` env
 *      compared in constant time against the `Authorization: Bearer`
 *      header. Use this if network isolation is infeasible (shared
 *      single-host setups).
 *
 * **Never** falls back to `NUXT_MCP_AUTH_TOKEN` — that's the agent's
 * Bearer (read by every Claude/Cursor session), and the privilege
 * model demands operator-tier credentials at this surface. A
 * compromised agent (prompt-injected, jailbroken) must not be able to
 * read fleet-level OAuth counts.
 *
 * Failure modes:
 *   - 503 NOT-CONFIGURED       — flag off, OR neither localhost nor a
 *                                non-empty admin token configured.
 *   - 401 ADMIN-TOKEN-MISSING  — token configured, request from outside
 *                                localhost, no Bearer header.
 *   - 401 ADMIN-TOKEN-INVALID  — Bearer present but doesn't match.
 *
 * Operator note: `lastRefreshOk` and `lastRefreshFail` are stubbed as
 * `null` in this commit — populating them requires a counter / last-
 * write timestamp that PR-2c's B24OAuth factory will add (next commit).
 * Until then the JSON shape is stable so downstream monitoring scripts
 * can target it without churn.
 */

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function timingSafeEqual(a: string, b: string): boolean {
  // Same pattern as mcp-auth.ts: length leak is acceptable for
  // fixed-length tokens (operator generates with `openssl rand -hex 32`).
  if (a.length !== b.length) return false
  return cryptoTimingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export default defineEventHandler((event) => {
  const logger = useLogger()
  const { bitrix24OauthEnabled, bitrix24OauthAdminToken, bitrix24OauthDbDir } = useRuntimeConfig()

  // Flag-off: refuse even to surface counts. The DB might not exist
  // (webhook-only deploy) so any query would crash; refusing here keeps
  // the failure mode loud (503 with `FLAG-OFF`) rather than 500 with a
  // SQLite stack trace.
  if (!bitrix24OauthEnabled) {
    void logger.warning('oauth.health.deny.flag-off')
    throw createError({
      statusCode: 503,
      statusMessage: 'oauth disabled',
      data: { errorCode: 'FLAG-OFF' },
    })
  }

  const adminToken = String(bitrix24OauthAdminToken ?? '').trim()
  // `getRequestIP` returns the source IP after h3's standard
  // forwarded-header parsing. For an nginx `proxy_pass` setup, this is
  // the upstream nginx (which we trust). The localhost check is the
  // "no admin token needed when reached via nginx allow/deny" path.
  const clientIp = getRequestIP(event, { xForwardedFor: true }) ?? ''
  const fromLocalhost = LOCALHOST_IPS.has(clientIp)

  // Fails closed: if neither auth mode is configured, 503. The route is
  // unreachable until the operator picks one.
  if (!adminToken && !fromLocalhost) {
    void logger.warning('oauth.health.deny.not-configured', { clientIp: clientIp || '<unknown>' })
    throw createError({
      statusCode: 503,
      statusMessage: 'health endpoint not configured: set NUXT_BITRIX24_OAUTH_ADMIN_TOKEN or restrict to localhost via nginx',
      data: { errorCode: 'NOT-CONFIGURED' },
    })
  }

  // Admin-token path: check the Bearer if a token is configured. Note:
  // localhost + admin-token both configured → admin-token wins, so a
  // dev box accessing via `curl http://localhost/api/oauth/_health`
  // STILL needs the Bearer. That's intentional — once the operator
  // opts in to token-based auth, the route is uniformly token-gated.
  if (adminToken) {
    const header = getHeader(event, 'authorization') ?? ''
    const match = header.match(/^Bearer\s+(.+)$/i)
    const token = match?.[1]?.trim()
    if (!token) {
      void logger.warning('oauth.health.deny.admin-token-missing', { clientIp: clientIp || '<unknown>' })
      throw createError({
        statusCode: 401,
        statusMessage: 'admin token required',
        data: { errorCode: 'ADMIN-TOKEN-MISSING' },
      })
    }
    if (!timingSafeEqual(token, adminToken)) {
      void logger.warning('oauth.health.deny.admin-token-invalid', { clientIp: clientIp || '<unknown>' })
      throw createError({
        statusCode: 401,
        statusMessage: 'admin token invalid',
        data: { errorCode: 'ADMIN-TOKEN-INVALID' },
      })
    }
  }

  // Happy path: aggregate counts from the token store. Synchronous —
  // `better-sqlite3` doesn't release the loop for SQL.
  const counts = useTokenStore().getHealthCounts()
  void logger.info('oauth.health.ok', counts)

  return {
    enabled: true,
    dbPath: `${String(bitrix24OauthDbDir ?? '/data')}/oauth.sqlite`,
    tenants: counts.tenants,
    bearers: counts.bearers,
    pendingStates: counts.pendingStates,
    // Stubbed null in PR-2c step 4. PR-2c step 6 (B24OAuth factory)
    // populates these from a process-local "last refresh result"
    // tracker the factory updates on every refresh attempt.
    lastRefreshOk: null,
    lastRefreshFail: null,
  }
})
