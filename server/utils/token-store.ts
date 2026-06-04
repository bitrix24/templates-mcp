import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { recordAuditEvent, type AuditActor } from '~/server/utils/audit-log'

/**
 * Per-tenant OAuth token + per-user Bearer storage for the multi-tenant
 * surface (`docs/OAUTH-DESIGN.md §5`). Sync SQLite (`better-sqlite3`) — fits
 * the MCP request path without forcing every tool to become async-aware
 * about token resolution, single file on a Docker volume so backups and
 * inspection are trivial.
 *
 * Three tables (composite PKs / FKs spelled out in §5):
 *
 *   - `oauth_tokens (member_id, user_id) PRIMARY KEY` — one row per
 *     `(portal × user)`. The composite PK is the whole point: without it
 *     the second user on the same portal would overwrite the first's
 *     tokens and silently impersonate them.
 *   - `mcp_tokens (bearer_hash PK, FK → oauth_tokens(member_id, user_id))`
 *     — Bearer tokens minted at install. Only the sha256 of the Bearer is
 *     ever persisted; the raw value is shown to the user exactly once on
 *     the callback HTML page and then forgotten by the server.
 *   - `oauth_state (state PK, 5-min TTL)` — CSRF/state nonces persisted so
 *     in-flight `/install → /callback` flows survive a Nitro restart.
 *
 * Audit-first invariant: every mutation calls `recordAuditEvent` BEFORE
 * the SQLite write. If audit fails, the DB write does not happen — "no
 * audit, no action" (the right posture for a credential-adjacent surface).
 * The reverse order would leave the DB ahead of the audit log on a write
 * failure, which is the compliance-hole this whole audit-log machinery
 * exists to prevent.
 *
 * Refresh / locking caveats from §5 (informational; not enforced here —
 * PR-2c's `useBitrix24OAuth` factory owns the per-tenant mutex):
 *   - `markRefreshFailed(memberId, userId)` stamps `revoked_at` only on
 *     `mcp_tokens` rows that point at *that specific* `(member_id,
 *     user_id)` pair — other users on the same portal are untouched.
 *   - Multi-process deployments are out of scope; the design assumes a
 *     single Nitro process (the deploy is `nginx-proxy` behind a single
 *     instance).
 *
 * Test seam: the {@link createTokenStore} factory takes a Database and
 * returns the bound API. Production code uses {@link useTokenStore} which
 * opens `${NUXT_BITRIX24_OAUTH_DB_DIR}/oauth.sqlite` lazily, sets WAL
 * mode, runs the schema, narrows file permissions to `0o600`, and caches
 * the resulting store for the life of the process. Tests pass
 * `new Database(':memory:')` directly so they don't touch the host fs and
 * don't share state between test files.
 */

/**
 * Owner of the OAuth row at the moment of recording.
 *
 * The schema is finalised in `docs/OAUTH-DESIGN.md §5`; the PR-2c
 * `B24OAuth` factory will hand back fully-populated rows from the
 * `oauth.bitrix24.tech/oauth/token` exchange response.
 */
export interface OAuthTokens {
  readonly memberId: string
  readonly userId: number
  readonly portalDomain: string
  readonly accessToken: string
  readonly refreshToken: string
  /** Unix seconds (UTC) — when the current `access_token` stops working. */
  readonly accessExpiresAt: number
  readonly scope: string
}

/** Storage-layer representation: same fields + audit-stamped timestamps. */
export interface OAuthTokensRow extends OAuthTokens {
  readonly createdAt: number
  readonly updatedAt: number
}

/** Result of `createMcpToken` — the only place the raw Bearer ever exists. */
export interface MintedMcpToken {
  /**
   * Raw Bearer to hand to the operator EXACTLY ONCE — never persisted on
   * the server side. The callback page in PR-2c is responsible for
   * `Cache-Control: no-store` so this value never leaks through a proxy
   * cache.
   */
  readonly bearer: string
  /** `sha256-` prefixed hex digest — what's stored and what audit logs reference. */
  readonly bearerHash: string
}

/** Active Bearer → tenant lookup result. */
export interface BearerLookup {
  readonly memberId: string
  readonly userId: number
}

/** A persisted install state nonce — created by `/install`, consumed by `/callback`. */
export interface OAuthState {
  readonly state: string
  readonly portal: string
  readonly clientId: string
  readonly csrfCookie: string
  readonly expiresAt: number
}

const OAUTH_DB_FILENAME = 'oauth.sqlite'
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    member_id          TEXT    NOT NULL,
    user_id            INTEGER NOT NULL,
    portal_domain      TEXT    NOT NULL,
    access_token       TEXT    NOT NULL,
    refresh_token      TEXT    NOT NULL,
    access_expires_at  INTEGER NOT NULL,
    scope              TEXT    NOT NULL,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL,
    PRIMARY KEY (member_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS mcp_tokens (
    bearer_hash        TEXT    PRIMARY KEY,
    member_id          TEXT    NOT NULL,
    user_id            INTEGER NOT NULL,
    label              TEXT,
    created_at         INTEGER NOT NULL,
    revoked_at         INTEGER,
    FOREIGN KEY (member_id, user_id)
      REFERENCES oauth_tokens(member_id, user_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS oauth_state (
    state              TEXT    PRIMARY KEY,
    portal             TEXT    NOT NULL,
    client_id          TEXT    NOT NULL,
    csrf_cookie        TEXT    NOT NULL,
    expires_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_user        ON oauth_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_mcp_member_user   ON mcp_tokens(member_id, user_id);
  CREATE INDEX IF NOT EXISTS idx_state_expires     ON oauth_state(expires_at);
`

/**
 * `sha256(bearer)` formatted as `sha256-<hex>` — matches the audit log's
 * `mcpTokenId` regex `^sha256-[a-f0-9]{1,64}$` (see `audit-log.ts`).
 */
function hashBearer(bearer: string): string {
  return `sha256-${createHash('sha256').update(bearer).digest('hex')}`
}

/** Unix seconds — the on-disk format. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Configures a freshly-opened (or :memory:) Database for the OAuth store.
 * Exported so tests can replay the same configuration on their in-memory DB.
 */
export function bootstrapSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
}

export interface TokenStore {
  /** Returns the OAuth row for a tenant, or `undefined` if none. */
  getTokens: (memberId: string, userId: number) => OAuthTokensRow | undefined
  /**
   * Inserts or updates the OAuth row for a tenant. `actor` distinguishes
   * `install` (first row) vs `refresh` (subsequent updates) — same SQL,
   * different audit signal.
   */
  upsertTokens: (tokens: OAuthTokens, actor: AuditActor) => Promise<void>
  /**
   * Stamps `revoked_at` on every active `mcp_tokens` row for this tenant
   * (so the MCP middleware will start returning 401 on the next request).
   * Does NOT delete the `oauth_tokens` row — refresh-token failure can be
   * transient (rate limit, brief network hiccup) and the tenant can re-
   * authorise without re-installing the marketplace app.
   */
  markRefreshFailed: (memberId: string, userId: number) => Promise<void>
  /**
   * Removes the OAuth row and CASCADE-deletes its `mcp_tokens` rows.
   * Called on hard uninstall / portal removal. Emits one `oauth.delete`
   * audit event for the OAuth row plus one `mcp.revoke` per Bearer.
   */
  deleteTenant: (memberId: string, userId: number, actor: AuditActor) => Promise<void>
  /**
   * Mints a fresh Bearer for a tenant. Returns the raw Bearer (shown to
   * the user exactly once) plus its hash (what's stored, what audit
   * references). The Bearer is 32 bytes of `crypto.randomBytes` → 256 bits
   * of entropy → a timing oracle on the SQLite existence check is
   * statistically irrelevant (see §8 of the design doc).
   */
  createMcpToken: (memberId: string, userId: number, label: string | undefined, actor: AuditActor) => Promise<MintedMcpToken>
  /**
   * Bearer → tenant lookup used by the MCP auth middleware (PR-2c). Returns
   * `undefined` for unknown or revoked Bearers — callers MUST treat that
   * uniformly as 401, NOT as "fall back to webhook".
   */
  findByBearerHash: (bearerHash: string) => BearerLookup | undefined
  /** Stamps `revoked_at` on a Bearer (idempotent — re-revoking a revoked row is a no-op). */
  revokeMcpToken: (bearerHash: string, actor: AuditActor) => Promise<void>
  /** Persists an install-state nonce. */
  createState: (state: OAuthState) => void
  /**
   * One-shot read-and-delete of a state nonce. Returns the persisted row
   * if the state exists AND has not expired, `undefined` otherwise.
   * Deletes the row in both cases (expired states cannot be replayed).
   */
  consumeState: (state: string) => OAuthState | undefined
  /** Test/operations only — count + expire eviction. */
  pruneExpiredStates: () => number
}

/**
 * Factory binding the API to a specific Database. Tests pass `:memory:`,
 * production uses {@link useTokenStore} which opens the on-disk file.
 *
 * Statements are prepared eagerly so a typo in the SQL fails at boot, not
 * on first request; the prepared statements are kept on the closure so
 * subsequent calls hit the prepared-statement cache.
 */
export function createTokenStore(db: Database.Database): TokenStore {
  bootstrapSchema(db)

  const stmts = {
    getTokens: db.prepare<[string, number]>(
      `SELECT member_id AS memberId, user_id AS userId, portal_domain AS portalDomain,
              access_token AS accessToken, refresh_token AS refreshToken,
              access_expires_at AS accessExpiresAt, scope,
              created_at AS createdAt, updated_at AS updatedAt
       FROM oauth_tokens WHERE member_id = ? AND user_id = ?`,
    ),
    upsertTokens: db.prepare<[string, number, string, string, string, number, string, number, number]>(
      `INSERT INTO oauth_tokens (member_id, user_id, portal_domain, access_token,
                                 refresh_token, access_expires_at, scope,
                                 created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(member_id, user_id) DO UPDATE SET
         portal_domain     = excluded.portal_domain,
         access_token      = excluded.access_token,
         refresh_token     = excluded.refresh_token,
         access_expires_at = excluded.access_expires_at,
         scope             = excluded.scope,
         updated_at        = excluded.updated_at`,
    ),
    deleteTokens: db.prepare<[string, number]>(
      `DELETE FROM oauth_tokens WHERE member_id = ? AND user_id = ?`,
    ),
    listMcpTokens: db.prepare<[string, number]>(
      `SELECT bearer_hash AS bearerHash FROM mcp_tokens
       WHERE member_id = ? AND user_id = ? AND revoked_at IS NULL`,
    ),
    markRefreshFailed: db.prepare<[number, string, number]>(
      `UPDATE mcp_tokens SET revoked_at = ?
       WHERE member_id = ? AND user_id = ? AND revoked_at IS NULL`,
    ),
    createMcpToken: db.prepare<[string, string, number, string | null, number]>(
      `INSERT INTO mcp_tokens (bearer_hash, member_id, user_id, label, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    findByBearerHash: db.prepare<[string]>(
      `SELECT member_id AS memberId, user_id AS userId
       FROM mcp_tokens WHERE bearer_hash = ? AND revoked_at IS NULL`,
    ),
    revokeMcpToken: db.prepare<[number, string]>(
      `UPDATE mcp_tokens SET revoked_at = ?
       WHERE bearer_hash = ? AND revoked_at IS NULL`,
    ),
    createState: db.prepare<[string, string, string, string, number]>(
      `INSERT INTO oauth_state (state, portal, client_id, csrf_cookie, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    selectState: db.prepare<[string]>(
      `SELECT state, portal, client_id AS clientId, csrf_cookie AS csrfCookie,
              expires_at AS expiresAt FROM oauth_state WHERE state = ?`,
    ),
    deleteState: db.prepare<[string]>(`DELETE FROM oauth_state WHERE state = ?`),
    pruneExpiredStates: db.prepare<[number]>(`DELETE FROM oauth_state WHERE expires_at < ?`),
  }

  return {
    getTokens: (memberId, userId) =>
      stmts.getTokens.get(memberId, userId) as OAuthTokensRow | undefined,

    upsertTokens: async (tokens, actor) => {
      // Audit-first: if the audit write fails, the DB row is NOT written.
      await recordAuditEvent({
        event: 'oauth.upsert',
        portal: tokens.memberId,
        userId: String(tokens.userId),
        actor,
      })
      const now = nowSec()
      stmts.upsertTokens.run(
        tokens.memberId,
        tokens.userId,
        tokens.portalDomain,
        tokens.accessToken,
        tokens.refreshToken,
        tokens.accessExpiresAt,
        tokens.scope,
        now,
        now,
      )
    },

    markRefreshFailed: async (memberId, userId) => {
      // Stamp every active Bearer for this tenant as revoked. Audit one
      // entry per affected Bearer so the forensic timeline shows exactly
      // which credentials died; the `system` actor distinguishes this
      // from a user-initiated revoke.
      const active = stmts.listMcpTokens.all(memberId, userId) as Array<{ bearerHash: string }>
      const now = nowSec()
      for (const { bearerHash } of active) {
        await recordAuditEvent({
          event: 'mcp.revoke',
          portal: memberId,
          userId: String(userId),
          mcpTokenId: bearerHash,
          actor: 'system',
        })
      }
      stmts.markRefreshFailed.run(now, memberId, userId)
    },

    deleteTenant: async (memberId, userId, actor) => {
      // Emit a `mcp.revoke` audit per active Bearer first (the CASCADE
      // delete that follows wipes them silently), then one `oauth.delete`
      // for the OAuth row itself.
      const active = stmts.listMcpTokens.all(memberId, userId) as Array<{ bearerHash: string }>
      for (const { bearerHash } of active) {
        await recordAuditEvent({
          event: 'mcp.revoke',
          portal: memberId,
          userId: String(userId),
          mcpTokenId: bearerHash,
          actor,
        })
      }
      await recordAuditEvent({
        event: 'oauth.delete',
        portal: memberId,
        userId: String(userId),
        actor,
      })
      stmts.deleteTokens.run(memberId, userId) // CASCADE wipes mcp_tokens rows
    },

    createMcpToken: async (memberId, userId, label, actor) => {
      const bearer = randomBytes(32).toString('hex')
      const bearerHash = hashBearer(bearer)
      await recordAuditEvent({
        event: 'mcp.create',
        portal: memberId,
        userId: String(userId),
        mcpTokenId: bearerHash,
        actor,
      })
      stmts.createMcpToken.run(bearerHash, memberId, userId, label ?? null, nowSec())
      return { bearer, bearerHash }
    },

    findByBearerHash: bearerHash =>
      stmts.findByBearerHash.get(bearerHash) as BearerLookup | undefined,

    revokeMcpToken: async (bearerHash, actor) => {
      // Look up the tenant for the audit-log fields BEFORE the UPDATE
      // (the row may still exist as a revoked stub afterwards, but we
      // want the audit to fire on the active-to-revoked transition).
      const row = stmts.findByBearerHash.get(bearerHash) as BearerLookup | undefined
      if (!row) return // already revoked or never existed — idempotent no-op
      await recordAuditEvent({
        event: 'mcp.revoke',
        portal: row.memberId,
        userId: String(row.userId),
        mcpTokenId: bearerHash,
        actor,
      })
      stmts.revokeMcpToken.run(nowSec(), bearerHash)
    },

    createState: state => {
      stmts.createState.run(
        state.state,
        state.portal,
        state.clientId,
        state.csrfCookie,
        state.expiresAt,
      )
    },

    consumeState: state => {
      const row = stmts.selectState.get(state) as OAuthState | undefined
      // Whether expired or not, the nonce is single-use — remove it before
      // returning. Callers see a fresh state on retry; an expired nonce
      // never doubles as a valid one.
      stmts.deleteState.run(state)
      if (!row) return undefined
      if (row.expiresAt < nowSec()) return undefined
      return row
    },

    pruneExpiredStates: () => stmts.pruneExpiredStates.run(nowSec()).changes,
  }
}

/**
 * Production singleton. Opens `${NUXT_BITRIX24_OAUTH_DB_DIR}/oauth.sqlite`
 * lazily on first call, sets WAL mode + the schema, narrows the file
 * permissions to `0o600`, and caches the resulting store for the life of
 * the process. Tests should call {@link createTokenStore} directly with a
 * `:memory:` Database instead — that path doesn't touch the host fs and
 * doesn't share state with other test files.
 *
 * @throws when `NUXT_BITRIX24_OAUTH_ENABLED` is `false` (callers shouldn't
 *   be touching the OAuth surface in that case — failing loud catches the
 *   wiring bug instead of silently creating an empty DB).
 */
let cachedStore: TokenStore | null = null
export function useTokenStore(): TokenStore {
  if (cachedStore) return cachedStore

  const { bitrix24OauthEnabled, bitrix24OauthDbDir } = useRuntimeConfig()
  if (!bitrix24OauthEnabled) {
    throw new Error(
      'useTokenStore() called while NUXT_BITRIX24_OAUTH_ENABLED=false. '
      + 'The OAuth surface should not be reachable in webhook-only mode; '
      + 'this is a wiring bug (PR-2c middleware should refuse the request '
      + 'before any token-store call).',
    )
  }

  const dir = bitrix24OauthDbDir || '/data'
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, OAUTH_DB_FILENAME)
  const db = new Database(file)
  // Narrow file perms — `0o600` matches the §5 contract (owner read/write
  // only). `chmod` happens after the file exists, which `new Database()`
  // guarantees (it creates the file if missing).
  chmodSync(file, 0o600)

  cachedStore = createTokenStore(db)
  return cachedStore
}

/**
 * Test-only — drops the cached singleton so the next `useTokenStore()` call
 * re-opens the DB. Production has no use for this.
 */
export function _resetTokenStoreSingletonForTests(): void {
  cachedStore = null
}
