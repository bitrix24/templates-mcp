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

/** Bearer inspection — includes the `revoked_at` timestamp so callers can tell `unknown` from `revoked`. */
export interface BearerInspection {
  readonly memberId: string
  readonly userId: number
  /** Unix seconds when revoked, or `null` if still active. */
  readonly revokedAt: number | null
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
 * Configures a freshly-opened (or `:memory:`) Database for the OAuth store
 * — WAL journal mode (no-op on `:memory:`, SQLite silently falls back), the
 * `synchronous = NORMAL` setting WAL needs, foreign-key enforcement for the
 * `mcp_tokens → oauth_tokens` CASCADE, and the three `CREATE TABLE IF NOT
 * EXISTS` statements.
 *
 * @internal Exported only so test files can replay the same configuration
 * on their `:memory:` Database without going through {@link useTokenStore}.
 * Production code MUST go through `useTokenStore()` (which calls this for
 * you) or `createTokenStore(db)` (which inlines it).
 */
export function bootstrapSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
}

export interface TokenStore {
  /**
   * Synchronous lookup on `(member_id, user_id)` — safe to call on the MCP
   * hot path (no `await`, no event-loop turn). Returns `undefined` for an
   * unknown tenant; callers MUST treat that as 401, NOT as a retry signal
   * or fall-through to webhook. Never throws on a missing row.
   */
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
   * Active-only Bearer → tenant lookup. Returns `undefined` for unknown OR
   * revoked Bearers — callers MUST treat that uniformly as 401, NOT as
   * "fall back to webhook".
   *
   * RETENTION NOTE (issue #222): the MCP auth middleware (#218) resolves via
   * `inspectBearer` instead (it needs the unknown/revoked/orphan
   * distinction), so this verb has no production caller TODAY. It is kept
   * deliberately as (a) the natural active-only primitive for the planned
   * "list / validate my Bearers" operator tool (#212), and (b) the canonical
   * is-this-Bearer-active probe used throughout the token-store test suite —
   * its active-only filter is exactly the assertion those tests want, where
   * `inspectBearer` would return a revoked row rather than `undefined`. Don't
   * route new production lookups through it without revisiting that contract.
   */
  findByBearerHash: (bearerHash: string) => BearerLookup | undefined
  /**
   * Bearer → tenant lookup that DOES NOT filter revoked rows — the
   * middleware uses this to distinguish unknown / revoked / orphan
   * (the three §11 `mcp.auth.deny.bearer-*` event suffixes). A revoked
   * row still resolves to a tenant pair so the audit log can record
   * "who tried to use this dead Bearer"; the middleware then refuses.
   * `findByBearerHash` is the active-only counterpart and stays the right
   * choice when the caller already treats unknown + revoked uniformly.
   */
  inspectBearer: (bearerHash: string) => BearerInspection | undefined
  /** Stamps `revoked_at` on a Bearer (idempotent — re-revoking a revoked row is a no-op). */
  revokeMcpToken: (bearerHash: string, actor: AuditActor) => Promise<void>
  /**
   * Persists an install-state nonce. Throws a SQLite `UNIQUE` constraint
   * error if `state` already exists — this is intentional: a collision on
   * a 32-byte random nonce is astronomically improbable; if one ever
   * happens (or a replay is attempted), the in-flight `/install` flow
   * hard-fails rather than silently overwriting a live CSRF binding.
   *
   * DoS note: `/install` is rate-limit-territory of PR-2c (tracked in
   * issue #211). Until that lands, a public deployment can be spammed
   * to grow this table by ~200 bytes per request; rows expire in 5 min
   * and `pruneExpiredStates` removes them, but the scheduler is not
   * wired by this PR (see below).
   */
  createState: (state: OAuthState) => void
  /**
   * One-shot atomic read-and-delete of a state nonce. Returns the
   * persisted row if the state existed, `undefined` if it never did.
   * The row is ALWAYS deleted (replay protection) — including expired
   * rows, so a stale nonce can't be reused.
   *
   * **Expiry is the caller's policy decision, not the store's.** The row
   * carries `expiresAt`; the caller (`/callback`) checks it and decides
   * whether to surface `STATE-EXPIRED` (an expected, benign outcome for
   * a slow user) vs `STATE-MISSING` (a never-seen nonce, possibly a
   * probe). Folding both into a single `undefined` return — as an
   * earlier revision did — erased that distinction in the logs and made
   * `oauth.callback.deny.state-expired` unemittable.
   */
  consumeState: (state: string) => OAuthState | undefined
  /**
   * Removes every `oauth_state` row whose `expires_at` is in the past;
   * returns the number of rows pruned. **Not scheduled by this PR** —
   * PR-2c is responsible for wiring a periodic call (`setInterval` on
   * a 5-minute cadence is sufficient given the 5-minute TTL) so the
   * table doesn't accumulate state from spammed `/install` requests.
   * Tracked in issue #211.
   */
  pruneExpiredStates: () => number
  /**
   * Aggregate counts for `/api/oauth/_health` (`docs/OAUTH-DESIGN.md §11`).
   * All three queries run in one synchronous bundle (`better-sqlite3` is
   * sync) so the endpoint is a single round-trip. **No PII, no tokens** —
   * counts only. The endpoint is the readiness target for orchestrators
   * (kubelet, docker-compose healthcheck), so cost matters: the underlying
   * tables are small (one row per tenant / bearer / pending state) and
   * each `COUNT(*)` is a constant-time index walk.
   */
  getHealthCounts: () => HealthCounts
  /**
   * Active Bearers issued to a specific tenant (#212). Returns one row per
   * Bearer that has NOT been revoked, newest-first. Used by the operator
   * tool `bx24mcp_list_sessions` so a user can answer "which device am I
   * still authorised on?" — the agent surfaces the labels + hash prefixes
   * the user picked at mint time.
   *
   * **NEVER returns the raw Bearer** — that exists only at mint time and
   * is never persisted. The hash prefix (first 8 hex chars of the SHA-256
   * over the raw Bearer) is enough to identify a session against what the
   * user pasted into Claude/Cursor (a 32-char Bearer's SHA-256 typically
   * starts with a distinctive prefix), useless as a credential by itself.
   */
  listMcpTokens: (memberId: string, userId: number) => ListedMcpToken[]
}

/** Shape returned by {@link TokenStore.listMcpTokens}. */
export interface ListedMcpToken {
  /**
   * First 8 hex characters of the SHA-256 over the raw Bearer — enough to
   * disambiguate "the one I called Laptop" from other sessions, far short
   * of a credential. NEVER use as an authentication signal.
   */
  readonly bearerHashPrefix: string
  /** Operator-supplied label at mint time ("MacBook Claude", etc.) or null. */
  readonly label: string | null
  /** Unix seconds at mint. */
  readonly createdAt: number
}

/** Shape returned by {@link TokenStore.getHealthCounts}. */
export interface HealthCounts {
  /** Number of `oauth_tokens` rows — distinct `(member_id, user_id)` tenants. */
  readonly tenants: number
  /** Number of active `mcp_tokens` rows (`revoked_at IS NULL`) — issued Bearers. */
  readonly bearers: number
  /** Number of `oauth_state` rows still inside the 5-min TTL. */
  readonly pendingStates: number
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
      `SELECT bearer_hash AS bearerHash,
              label,
              created_at AS createdAt
       FROM mcp_tokens
       WHERE member_id = ? AND user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`,
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
    inspectBearer: db.prepare<[string]>(
      `SELECT member_id AS memberId, user_id AS userId, revoked_at AS revokedAt
       FROM mcp_tokens WHERE bearer_hash = ?`,
    ),
    revokeMcpToken: db.prepare<[number, string]>(
      `UPDATE mcp_tokens SET revoked_at = ?
       WHERE bearer_hash = ? AND revoked_at IS NULL`,
    ),
    createState: db.prepare<[string, string, string, string, number]>(
      `INSERT INTO oauth_state (state, portal, client_id, csrf_cookie, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    // `DELETE ... RETURNING` is a single atomic statement (SQLite ≥ 3.35,
    // shipped with better-sqlite3 11.x). The earlier `SELECT` + `DELETE`
    // pair was a TOCTOU window: two concurrent `/callback` requests for
    // the same state could both read the row before either deleted it,
    // letting the nonce be "consumed" twice. better-sqlite3 is sync, so
    // intra-process concurrency is impossible — but a rolling Nitro
    // restart can leave two processes briefly overlapping, and that's a
    // documented production scenario (§8 — "state persisted so flows
    // survive a Nitro restart"). The atomic single-statement closes that
    // window for the cost of zero added complexity.
    consumeState: db.prepare<[string]>(
      `DELETE FROM oauth_state WHERE state = ?
       RETURNING state, portal, client_id AS clientId,
                 csrf_cookie AS csrfCookie, expires_at AS expiresAt`,
    ),
    pruneExpiredStates: db.prepare<[number]>(`DELETE FROM oauth_state WHERE expires_at < ?`),
    countTenants: db.prepare(`SELECT COUNT(*) AS n FROM oauth_tokens`),
    countActiveBearers: db.prepare(`SELECT COUNT(*) AS n FROM mcp_tokens WHERE revoked_at IS NULL`),
    countPendingStates: db.prepare<[number]>(`SELECT COUNT(*) AS n FROM oauth_state WHERE expires_at > ?`),
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
      //
      // Compliance posture for bulk operations: audits are gathered via
      // `Promise.all` (fail-fast) BEFORE the DB write so that ANY audit
      // rejection skips the DB write entirely — same "no audit, no
      // action" invariant as the single-row mutations above. Residual
      // risk: the audit log's `writeChain` is FIFO single-writer; if the
      // disk fills mid-batch, the audits that already resolved are on
      // disk while the rejecting one is not — the DB write is correctly
      // skipped, but the audit log carries "intent" records for the
      // resolved ones. Callers MUST treat the rejection as a retryable
      // failure of the WHOLE operation; on retry, idempotent re-runs are
      // safe (each `mcp.revoke` event repeats but the DB UPDATE remains
      // a no-op against rows already stamped with `revoked_at`).
      const active = stmts.listMcpTokens.all(memberId, userId) as Array<{ bearerHash: string }>
      await Promise.all(active.map(({ bearerHash }) => recordAuditEvent({
        event: 'mcp.revoke',
        portal: memberId,
        userId: String(userId),
        mcpTokenId: bearerHash,
        actor: 'system',
      })))
      stmts.markRefreshFailed.run(nowSec(), memberId, userId)
    },

    deleteTenant: async (memberId, userId, actor) => {
      // Same bulk-audit-first contract as markRefreshFailed: N `mcp.revoke`
      // audits, then a final `oauth.delete`; on ANY rejection nothing in
      // the DB changes. Forensic posture: the `mcp.revoke` batch runs via
      // `Promise.all` (fail-fast — any single revoke audit failing skips
      // the delete), and the `oauth.delete` audit is awaited AFTER the
      // batch so a missing `oauth.delete` next to N `mcp.revoke` records
      // unambiguously marks a partial-failure tenant. With the alternative
      // (all N+1 in one Promise.all) the failure mode would still be
      // skip-the-write, but `mcp.revoke` and `oauth.delete` would race —
      // a GDPR-style data-subject request reading the log out-of-order
      // would have to disambiguate. The DB DELETE relies on SQLite's
      // built-in per-statement atomicity for the FK CASCADE: `DELETE FROM
      // oauth_tokens` and the CASCADE-driven `mcp_tokens` wipe land in
      // the same implicit transaction. No outer `db.transaction(...)`
      // needed.
      const active = stmts.listMcpTokens.all(memberId, userId) as Array<{ bearerHash: string }>
      await Promise.all(active.map(({ bearerHash }) => recordAuditEvent({
        event: 'mcp.revoke',
        portal: memberId,
        userId: String(userId),
        mcpTokenId: bearerHash,
        actor,
      })))
      await recordAuditEvent({
        event: 'oauth.delete',
        portal: memberId,
        userId: String(userId),
        actor,
      })
      stmts.deleteTokens.run(memberId, userId) // CASCADE wipes mcp_tokens
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

    inspectBearer: bearerHash =>
      stmts.inspectBearer.get(bearerHash) as BearerInspection | undefined,

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

    listMcpTokens: (memberId, userId) => {
      // Hash → prefix at the boundary so the public surface NEVER carries
      // the full hash (still useless as a credential, but less is less —
      // an operator pasting the result into an issue / Slack / agent
      // transcript can't reveal even the full digest by accident).
      //
      // `bearer_hash` is stored as `sha256-<64 hex>` (algo-prefixed —
      // future-proofing for an algorithm bump). The issue #212 spec
      // asks for "the first 8 hex chars of the SHA-256", so strip the
      // `sha256-` literal before slicing; otherwise the prefix would be
      // `sha256-X` (zero entropy, useless for disambiguation).
      const rows = stmts.listMcpTokens.all(memberId, userId) as Array<{
        bearerHash: string
        label: string | null
        createdAt: number
      }>
      return rows.map((r) => {
        const hex = r.bearerHash.startsWith('sha256-')
          ? r.bearerHash.slice('sha256-'.length)
          : r.bearerHash
        return {
          bearerHashPrefix: hex.slice(0, 8),
          label: r.label,
          createdAt: r.createdAt,
        }
      })
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
      // Atomic single-statement read-and-delete (see `stmts.consumeState`
      // for the TOCTOU rationale). The nonce is removed whether expired
      // or not — an expired row cannot be replayed by a later
      // create-with-same-state, and a fresh `/install` always lands a new
      // random state. Expiry is NOT filtered here: the row is returned
      // with its `expiresAt` so the caller can distinguish expired from
      // never-existed (see the interface JSDoc).
      return stmts.consumeState.get(state) as OAuthState | undefined
    },

    pruneExpiredStates: () => stmts.pruneExpiredStates.run(nowSec()).changes,

    getHealthCounts: () => {
      const now = nowSec()
      return {
        tenants: (stmts.countTenants.get() as { n: number }).n,
        bearers: (stmts.countActiveBearers.get() as { n: number }).n,
        pendingStates: (stmts.countPendingStates.get(now) as { n: number }).n,
      }
    },
  }
}

/**
 * Validates a directory path coming from operator env. Mirrors the audit
 * log's `resolveAuditDir` posture (`docs/SECURITY-AUDIT.md` follow-up
 * #66): no `..` segments, absolute path required. Without these checks an
 * env-var typo could land `oauth.sqlite` in a surprise directory under
 * `process.cwd()` (which is unpredictable under Docker/systemd).
 */
function resolveDbDir(): string {
  const fromEnv = useRuntimeConfig().bitrix24OauthDbDir?.trim()
  if (!fromEnv) return '/data'
  // Split on BOTH separators (issue #222): `path.sep` is `/` on Linux, so a
  // Windows-style `C:\data\..` would split to a single element and the `..`
  // would slip through. Mirror `resolveAuditDir` (`audit-log.ts`) exactly.
  if (fromEnv.split(/[/\\]/).some(seg => seg === '..')) {
    throw new Error(`NUXT_BITRIX24_OAUTH_DB_DIR rejected: path-traversal segment "..": ${fromEnv}`)
  }
  if (!path.isAbsolute(fromEnv)) {
    throw new Error(`NUXT_BITRIX24_OAUTH_DB_DIR rejected: must be an absolute path, got: ${fromEnv}`)
  }
  return path.resolve(fromEnv)
}

/**
 * Production singleton. Opens `${NUXT_BITRIX24_OAUTH_DB_DIR}/oauth.sqlite`
 * lazily on first call, sets WAL mode + the schema, narrows the file
 * permissions to `0o600`, and caches the resulting store for the life of
 * the process. Tests should call {@link createTokenStore} directly with a
 * `:memory:` Database instead — that path doesn't touch the host fs and
 * doesn't share state with other test files.
 *
 * File-permission caveat: `new Database(file)` creates `oauth.sqlite` with
 * the process umask (typically `0o644`), and `chmodSync` narrows it to
 * `0o600` immediately after. A microsecond race window exists between the
 * two — but the parent directory is `0o700`, so non-owner uids in the same
 * container can't traverse into it regardless of what `oauth.sqlite`'s
 * mode is during that window. The race is mitigated by the parent dir's
 * permissions, not by the chmod alone.
 *
 * @throws when `NUXT_BITRIX24_OAUTH_ENABLED` is `false` (callers shouldn't
 *   be touching the OAuth surface in that case — failing loud catches the
 *   wiring bug instead of silently creating an empty DB).
 * @throws when `NUXT_BITRIX24_OAUTH_DB_DIR` carries a `..` segment or is
 *   not absolute (operator-config validation; see {@link resolveDbDir}).
 */
let cachedStore: TokenStore | null = null
export function useTokenStore(): TokenStore {
  if (cachedStore) return cachedStore

  const { bitrix24OauthEnabled } = useRuntimeConfig()
  if (!bitrix24OauthEnabled) {
    throw new Error(
      'useTokenStore() called while NUXT_BITRIX24_OAUTH_ENABLED=false. '
      + 'The OAuth surface should not be reachable in webhook-only mode; '
      + 'this is a wiring bug (PR-2c middleware should refuse the request '
      + 'before any token-store call).',
    )
  }

  const dir = resolveDbDir()
  // mkdirSync's `mode` is honoured only when the directory is created (it
  // does NOT apply to an existing directory — Linux `mkdir(2)` returns
  // EEXIST and ignores the flag). When the operator pre-mounted /data with
  // whatever permissions Docker / their volume driver chose, an explicit
  // `chmodSync` narrows it to the expected `0o700`.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const file = path.join(dir, OAUTH_DB_FILENAME)
  const db = new Database(file)
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
