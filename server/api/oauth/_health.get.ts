import { createError, defineEventHandler, getHeader, getRequestIP } from 'h3'
import { timingSafeEqualStr } from '~/server/utils/auth-helpers'
import { _readRefreshStatus } from '~/server/utils/bitrix24-oauth'
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
 *   GET /api/oauth/_health   →  200 { enabled, tenants, bearers,
 *     pendingStates, lastRefreshOk, lastRefreshFail, processStartedAt }
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
 *   - 503 FLAG-OFF             — `NUXT_BITRIX24_OAUTH_ENABLED=false`.
 *   - 503 NOT-CONFIGURED       — flag on, but neither localhost nor a
 *                                non-empty admin token is configured.
 *   - 401 ADMIN-TOKEN-MISSING  — token configured, request from outside
 *                                localhost, no Bearer header.
 *   - 401 ADMIN-TOKEN-INVALID  — Bearer present but doesn't match.
 *
 * Operator note: `lastRefreshOk` / `lastRefreshFail` are `null` until a
 * token refresh has run (populated by the B24OAuth factory's
 * process-local tracker). `processStartedAt` (unix seconds, captured at
 * module load) lets a dashboard distinguish "null because the process
 * just restarted" from "null because no refresh ever ran".
 */

/**
 * True for any loopback source IP. Accepts the whole `127.0.0.0/8`
 * range (RFC 5735 — not just `127.0.0.1`), plus IPv6 `::1` and the
 * IPv4-mapped-IPv6 forms. An orchestrator health-probe binding to a
 * non-`.1` loopback address (`127.0.0.2`, etc.) is legitimate traffic
 * and must pass the localhost gate. The source IP is the raw socket
 * address (see the handler), which a remote attacker cannot forge.
 */
function isLoopback(ip: string): boolean {
  if (ip === '::1') return true
  // Strip the IPv4-mapped-IPv6 prefix if present (`::ffff:127.0.0.1`).
  const v4 = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip
  const octets = v4.split('.')
  return octets.length === 4 && octets[0] === '127'
    && octets.every(o => /^\d{1,3}$/.test(o) && Number(o) <= 255)
}

// Captured once at module load. Exposed in the health payload so a
// monitoring dashboard can tell "lastRefreshOk is null because the
// process just restarted" from "null because no refresh ever ran" —
// both would otherwise be indistinguishable nulls.
const PROCESS_STARTED_AT = Math.floor(Date.now() / 1000)

export default defineEventHandler((event) => {
  const logger = useLogger()
  const { bitrix24OauthEnabled, bitrix24OauthAdminToken } = useRuntimeConfig()

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
  // Use the raw SOCKET IP only — NEVER `{ xForwardedFor: true }`. A
  // client-supplied `X-Forwarded-For: 127.0.0.1` header would otherwise
  // spoof the localhost check and read fleet counts without a token.
  // The "reached via nginx allow/deny" pattern relies on the network
  // namespace (the request genuinely arrives from 127.0.0.1 inside the
  // container), not on a forwarded header.
  const clientIp = getRequestIP(event) ?? ''
  const fromLocalhost = isLoopback(clientIp)

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
    if (!timingSafeEqualStr(token, adminToken)) {
      void logger.warning('oauth.health.deny.admin-token-invalid', { clientIp: clientIp || '<unknown>' })
      throw createError({
        statusCode: 401,
        statusMessage: 'admin token invalid',
        data: { errorCode: 'ADMIN-TOKEN-INVALID' },
      })
    }
  }

  // Happy path: aggregate counts from the token store. Synchronous —
  // `better-sqlite3` doesn't release the loop for SQL. `lastRefreshOk`
  // / `lastRefreshFail` come from the B24OAuth factory's process-local
  // tracker (PR-2c step 7) — both `null` on a fresh process is the
  // correct signal that no refresh has been attempted yet.
  const counts = useTokenStore().getHealthCounts()
  const refresh = _readRefreshStatus()
  void logger.info('oauth.health.ok', { ...counts, ...refresh })

  // No `dbPath` in the body — a filesystem path is infrastructure
  // topology that aids an attacker who's already past the auth gate
  // (or reaches the route through a misconfigured nginx). Counts +
  // refresh timestamps are all a readiness probe / dashboard needs.
  return {
    enabled: true,
    tenants: counts.tenants,
    bearers: counts.bearers,
    pendingStates: counts.pendingStates,
    lastRefreshOk: refresh.lastRefreshOk,
    lastRefreshFail: refresh.lastRefreshFail,
    processStartedAt: PROCESS_STARTED_AT,
  }
})
