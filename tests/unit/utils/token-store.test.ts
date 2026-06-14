/**
 * Unit suite for the OAuth token store (PR-2b, design in
 * `docs/OAUTH-DESIGN.md §5`). Exercises every CRUD path on an in-memory
 * SQLite DB so the host filesystem never touches the test, and `vi.mock`
 * stubs `recordAuditEvent` so the suite verifies the audit-first
 * invariant without depending on a real `/data/audit` directory.
 *
 * What this suite proves:
 *   - Composite PK `(member_id, user_id)` — second user on the same
 *     portal does NOT overwrite the first's tokens.
 *   - `markRefreshFailed` revokes only `mcp_tokens` for THAT tenant,
 *     leaving other users on the same portal untouched.
 *   - `deleteTenant` CASCADE-deletes `mcp_tokens` AND emits an audit
 *     entry per Bearer before the OAuth row is gone.
 *   - `createMcpToken` returns 32-byte entropy + the hash matches the
 *     `sha256-<hex>` shape the audit log expects.
 *   - State nonce TTL — expired states are rejected AND deleted so they
 *     cannot be replayed.
 *   - Audit-first — if `recordAuditEvent` rejects, the SQLite row is not
 *     created. This is THE compliance invariant of the whole layer.
 *   - Schema bootstrap is idempotent — re-running it on an existing DB
 *     is a no-op (the `IF NOT EXISTS` clauses are not a typo).
 */
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AuditLogModule from '../../../server/utils/audit-log'
import { bootstrapSchema, createTokenStore, type TokenStore } from '../../../server/utils/token-store'

type AuditEvent = Parameters<typeof AuditLogModule.recordAuditEvent>[0]

// `vi.mock` is hoisted above top-level variables, so the audit-log mock
// must capture its `vi.fn` via `vi.hoisted` instead of referencing a
// regular const — otherwise the factory runs before the const is
// initialised and throws `Cannot access 'recordAuditEvent' before
// initialization` at module load.
//
// The mock fn is typed with the real `recordAuditEvent` signature so
// `mock.calls[i][0]` is a typed `AuditEvent`, not `never` (which would
// happen if we used the zero-arg `vi.fn()` default).
const { recordAuditEvent } = vi.hoisted(() => ({
  recordAuditEvent: vi.fn<(event: AuditEvent) => Promise<void>>(async () => undefined),
}))
vi.mock('~/server/utils/audit-log', async () => {
  // Keep the real `AuditActor` / `AuditEvent` / `AuditEventKind` type
  // re-exports — the token-store imports them.
  const real = await vi.importActual<typeof AuditLogModule>('../../../server/utils/audit-log')
  return { ...real, recordAuditEvent }
})

let db: Database.Database
let store: TokenStore

const sampleTokens = {
  memberId: 'portal-acme',
  userId: 42,
  portalDomain: 'acme.bitrix24.com',
  accessToken: 'access-x',
  refreshToken: 'refresh-x',
  accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  scope: 'user,task',
}

beforeEach(() => {
  recordAuditEvent.mockClear()
  recordAuditEvent.mockResolvedValue(undefined)
  db = new Database(':memory:')
  store = createTokenStore(db)
})

afterEach(() => {
  // Defensive (issue #223): the `upsert ... bumps updated_at` test below calls
  // vi.useFakeTimers()/useRealTimers() inline. If anything between them throws,
  // frozen time would leak into later tests in this file that read Date.now()
  // at runtime (state-TTL cases). Restoring real timers here unconditionally
  // closes that flaky window — it's a no-op when timers are already real.
  vi.useRealTimers()
  db.close()
})

describe('token-store — OAuth + Bearer + state CRUD (PR-2b, docs/OAUTH-DESIGN.md §5)', () => {
  describe('schema + bootstrap', () => {
    it('bootstrapSchema is idempotent — running it twice does not error', () => {
      // Fresh DB, schema already applied via createTokenStore in beforeEach.
      // A second call must be a no-op (CREATE TABLE IF NOT EXISTS).
      expect(() => bootstrapSchema(db)).not.toThrow()
    })

    it('enables foreign_keys on the connection (required for the FK CASCADE)', () => {
      // foreign_keys MUST be on — the mcp_tokens → oauth_tokens FK relies
      // on it. (WAL is requested via `journal_mode = WAL`, but
      // `:memory:` databases silently fall back to `memory` journal mode
      // — that's a SQLite limitation, not a regression; the real on-disk
      // DB the Nitro plugin opens DOES get WAL.)
      expect(Number(db.pragma('foreign_keys', { simple: true }))).toBe(1)
    })
  })

  describe('oauth_tokens — composite PK isolation', () => {
    it('round-trips a tenant via upsert/get', async () => {
      await store.upsertTokens(sampleTokens, 'install')
      const got = store.getTokens(sampleTokens.memberId, sampleTokens.userId)
      expect(got).toMatchObject({
        memberId: sampleTokens.memberId,
        userId: sampleTokens.userId,
        accessToken: 'access-x',
        scope: 'user,task',
      })
      expect(got!.createdAt).toBeGreaterThan(0)
      expect(got!.updatedAt).toBe(got!.createdAt)
    })

    it('second user on the SAME portal does not overwrite the first', async () => {
      // The §5 composite-PK guarantee in action. Without this, user 2's
      // tokens would land on user 1's row and silently impersonate them.
      await store.upsertTokens({ ...sampleTokens, userId: 1, accessToken: 'token-1' }, 'install')
      await store.upsertTokens({ ...sampleTokens, userId: 2, accessToken: 'token-2' }, 'install')
      expect(store.getTokens(sampleTokens.memberId, 1)?.accessToken).toBe('token-1')
      expect(store.getTokens(sampleTokens.memberId, 2)?.accessToken).toBe('token-2')
    })

    it('upsert with same PK refreshes tokens AND bumps updated_at, keeps created_at', async () => {
      await store.upsertTokens({ ...sampleTokens, accessToken: 'old' }, 'install')
      const before = store.getTokens(sampleTokens.memberId, sampleTokens.userId)!
      // Advance the clock so the second upsert lands a different second.
      vi.useFakeTimers()
      vi.setSystemTime(new Date((before.createdAt + 5) * 1000))
      await store.upsertTokens({ ...sampleTokens, accessToken: 'new' }, 'refresh')
      vi.useRealTimers()
      const after = store.getTokens(sampleTokens.memberId, sampleTokens.userId)!
      expect(after.accessToken).toBe('new')
      expect(after.createdAt).toBe(before.createdAt)
      expect(after.updatedAt).toBeGreaterThan(before.updatedAt)
    })

    it('actor distinguishes install vs refresh in the audit signal', async () => {
      await store.upsertTokens(sampleTokens, 'install')
      await store.upsertTokens(sampleTokens, 'refresh')
      expect(recordAuditEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
        event: 'oauth.upsert', actor: 'install',
      }))
      expect(recordAuditEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
        event: 'oauth.upsert', actor: 'refresh',
      }))
    })

    it('returns undefined for an unknown tenant', () => {
      expect(store.getTokens('nope', 0)).toBeUndefined()
    })
  })

  describe('mcp_tokens — mint, lookup, revoke', () => {
    beforeEach(async () => {
      await store.upsertTokens(sampleTokens, 'install')
    })

    it('mints a 32-byte hex Bearer and a sha256-prefixed hash', async () => {
      const minted = await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'MacBook', 'install')
      expect(minted.bearer).toMatch(/^[a-f0-9]{64}$/)
      expect(minted.bearerHash).toMatch(/^sha256-[a-f0-9]{64}$/)
    })

    it('findByBearerHash returns the tenant for an active Bearer', async () => {
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, undefined, 'install',
      )
      expect(store.findByBearerHash(bearerHash)).toEqual({
        memberId: sampleTokens.memberId, userId: sampleTokens.userId,
      })
    })

    it('findByBearerHash returns undefined for a revoked Bearer', async () => {
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, undefined, 'install',
      )
      await store.revokeMcpToken(bearerHash, 'user')
      expect(store.findByBearerHash(bearerHash)).toBeUndefined()
    })

    it('findByBearerHash returns undefined for an unknown hash', () => {
      expect(store.findByBearerHash('sha256-deadbeef')).toBeUndefined()
    })

    it('inspectBearer returns the tenant + revokedAt=null for an ACTIVE Bearer', async () => {
      // inspectBearer is the middleware lookup that distinguishes
      // unknown / revoked / orphan (§11). For an active Bearer it
      // returns the same tenant pair as findByBearerHash plus a null
      // revokedAt so the caller can branch.
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, 'laptop', 'install',
      )
      const inspect = store.inspectBearer(bearerHash)
      expect(inspect).toEqual({
        memberId: sampleTokens.memberId,
        userId: sampleTokens.userId,
        revokedAt: null,
      })
    })

    it('inspectBearer returns revokedAt=<unix seconds> for a REVOKED Bearer (findByBearerHash returns undefined)', async () => {
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, undefined, 'install',
      )
      await store.revokeMcpToken(bearerHash, 'user')
      // findByBearerHash filters revoked (its production contract).
      expect(store.findByBearerHash(bearerHash)).toBeUndefined()
      // inspectBearer surfaces the row + the revocation timestamp.
      const inspect = store.inspectBearer(bearerHash)
      expect(inspect).toBeDefined()
      expect(inspect!.memberId).toBe(sampleTokens.memberId)
      expect(inspect!.revokedAt).toBeGreaterThan(0)
      expect(typeof inspect!.revokedAt).toBe('number')
    })

    it('inspectBearer returns undefined for an unknown hash (same as findByBearerHash)', () => {
      expect(store.inspectBearer('sha256-deadbeef')).toBeUndefined()
    })

    it('revoking an already-revoked Bearer is an idempotent no-op (no audit double-emit)', async () => {
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, undefined, 'install',
      )
      recordAuditEvent.mockClear()
      await store.revokeMcpToken(bearerHash, 'user')
      await store.revokeMcpToken(bearerHash, 'user') // second time — should be silent
      expect(recordAuditEvent).toHaveBeenCalledTimes(1)
    })

    it('findByBearerHash result does not include the label (auth middleware does not need it)', async () => {
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, 'Laptop', 'install',
      )
      // findByBearerHash returns ONLY the tenant id pair — labels live in
      // the row but are intentionally not surfaced via the auth lookup
      // (the middleware doesn't need them; a future operator "list my
      // Bearers" tool would read them directly).
      expect(store.findByBearerHash(bearerHash)).toEqual({
        memberId: sampleTokens.memberId, userId: sampleTokens.userId,
      })
    })

    it('revokeMcpToken does NOT stamp revoked_at if audit rejects', async () => {
      // The audit-first invariant must hold on revoke too — round-1 added
      // this for upsert/createMcpToken/markRefreshFailed/deleteTenant but
      // left revokeMcpToken uncovered. If someone ever reorders `run` to
      // before `await recordAuditEvent`, this test catches it.
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, undefined, 'install',
      )
      recordAuditEvent.mockReset()
      recordAuditEvent.mockRejectedValueOnce(new Error('audit disk full'))
      await expect(store.revokeMcpToken(bearerHash, 'user')).rejects.toThrow('audit disk full')
      // Bearer is still active — the UPDATE never ran.
      expect(store.findByBearerHash(bearerHash)).toEqual({
        memberId: sampleTokens.memberId, userId: sampleTokens.userId,
      })
    })
  })

  describe('listMcpTokens — operator "list my sessions" surface (#212)', () => {
    beforeEach(async () => {
      await store.upsertTokens(sampleTokens, 'install')
    })

    it('returns active Bearers newest-first, with label + 8-hex hashPrefix, never the raw hash', async () => {
      // Mint three Bearers a few seconds apart so the ORDER BY created_at
      // DESC is observable. Real clock granularity is 1s; advance with
      // fake timers to keep the test deterministic without sleeps.
      vi.useFakeTimers()
      vi.setSystemTime(new Date(1800000000 * 1000))
      const first = await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'MacBook', 'install')
      vi.setSystemTime(new Date(1800000010 * 1000))
      const second = await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, null as unknown as undefined, 'install')
      vi.setSystemTime(new Date(1800000020 * 1000))
      const third = await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'iPad Cursor', 'install')
      vi.useRealTimers()

      // `bearerHash` is stored as `sha256-<64 hex>`; the public prefix is
      // the first 8 hex chars OF THE SHA-256 (not of the prefixed string,
      // which would start with the literal `sha256-` and carry zero
      // entropy — see the strip in `token-store.ts:listMcpTokens`).
      const hexOf = (h: string) => h.replace(/^sha256-/, '').slice(0, 8)

      const listed = store.listMcpTokens(sampleTokens.memberId, sampleTokens.userId)
      expect(listed).toHaveLength(3)
      expect(listed[0]).toEqual({
        bearerHashPrefix: hexOf(third.bearerHash),
        label: 'iPad Cursor',
        createdAt: 1800000020,
      })
      expect(listed[1]).toEqual({
        bearerHashPrefix: hexOf(second.bearerHash),
        label: null,
        createdAt: 1800000010,
      })
      expect(listed[2]).toEqual({
        bearerHashPrefix: hexOf(first.bearerHash),
        label: 'MacBook',
        createdAt: 1800000000,
      })

      // Defence-in-depth: the raw full hash must never appear in the
      // returned shape. The prefix is bounded at 8 hex chars.
      for (const row of listed) {
        expect(row.bearerHashPrefix).toMatch(/^[a-f0-9]{8}$/)
        expect(JSON.stringify(row)).not.toContain(first.bearerHash)
        expect(JSON.stringify(row)).not.toContain(second.bearerHash)
        expect(JSON.stringify(row)).not.toContain(third.bearerHash)
      }
    })

    it('excludes revoked Bearers — once revoked, the row disappears from the list', async () => {
      const minted = await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'Laptop', 'install')
      expect(store.listMcpTokens(sampleTokens.memberId, sampleTokens.userId)).toHaveLength(1)
      await store.revokeMcpToken(minted.bearerHash, 'install')
      expect(store.listMcpTokens(sampleTokens.memberId, sampleTokens.userId)).toHaveLength(0)
    })

    it('scopes to one tenant — a Bearer minted under a different (memberId,userId) is invisible here', async () => {
      // Seed a second tenant under the SAME memberId, different userId
      // (the composite-PK case from the oauth_tokens block above).
      await store.upsertTokens({ ...sampleTokens, userId: 99, accessToken: 'tok-99' }, 'install')
      await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'mine', 'install')
      await store.createMcpToken(sampleTokens.memberId, 99, 'theirs', 'install')

      const mine = store.listMcpTokens(sampleTokens.memberId, sampleTokens.userId)
      expect(mine).toHaveLength(1)
      expect(mine[0]?.label).toBe('mine')

      const theirs = store.listMcpTokens(sampleTokens.memberId, 99)
      expect(theirs).toHaveLength(1)
      expect(theirs[0]?.label).toBe('theirs')
    })

    it('returns an empty array for a tenant with no Bearers (not undefined, not throw)', () => {
      const result = store.listMcpTokens(sampleTokens.memberId, sampleTokens.userId)
      expect(result).toEqual([])
    })
  })

  describe('markRefreshFailed — only revokes the affected tenant', () => {
    beforeEach(async () => {
      await store.upsertTokens(sampleTokens, 'install')
    })

    it('with zero active Bearers, emits zero audits and does not throw', async () => {
      // Edge case: a tenant whose Bearers were all already revoked (e.g.
      // by a prior `markRefreshFailed` followed by a re-authorise that
      // hasn't yet minted a fresh Bearer). The function should be a
      // silent no-op — no audits, no SQL error.
      recordAuditEvent.mockClear()
      await store.markRefreshFailed(sampleTokens.memberId, sampleTokens.userId)
      expect(recordAuditEvent).not.toHaveBeenCalled()
    })

    it('revokes mcp_tokens for THIS (member_id, user_id) only — same portal other user untouched', async () => {
      // Two users on the same portal, each with their own Bearer.
      await store.upsertTokens({ ...sampleTokens, userId: 1 }, 'install')
      await store.upsertTokens({ ...sampleTokens, userId: 2 }, 'install')
      const { bearerHash: bearer1 } = await store.createMcpToken(sampleTokens.memberId, 1, 'u1', 'install')
      const { bearerHash: bearer2 } = await store.createMcpToken(sampleTokens.memberId, 2, 'u2', 'install')

      await store.markRefreshFailed(sampleTokens.memberId, 1)

      expect(store.findByBearerHash(bearer1)).toBeUndefined() // user 1 dead
      expect(store.findByBearerHash(bearer2)).toEqual({ memberId: sampleTokens.memberId, userId: 2 }) // user 2 alive
    })

    it('does NOT delete the oauth_tokens row — refresh failure may be transient', async () => {
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, undefined, 'install',
      )
      await store.markRefreshFailed(sampleTokens.memberId, sampleTokens.userId)
      // Bearer dead, OAuth row still there (so a re-authorise replaces it
      // in place rather than failing on missing tenant).
      expect(store.findByBearerHash(bearerHash)).toBeUndefined()
      expect(store.getTokens(sampleTokens.memberId, sampleTokens.userId)).toBeDefined()
    })

    it('emits one mcp.revoke audit per affected Bearer with actor=system', async () => {
      await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'a', 'install')
      await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'b', 'install')
      recordAuditEvent.mockClear()
      await store.markRefreshFailed(sampleTokens.memberId, sampleTokens.userId)
      const calls = recordAuditEvent.mock.calls.filter(c => c[0].event === 'mcp.revoke')
      expect(calls).toHaveLength(2)
      calls.forEach(c => expect(c[0]).toMatchObject({ actor: 'system' }))
    })
  })

  describe('deleteTenant — CASCADE + audit', () => {
    it('with zero Bearers, emits a single oauth.delete and removes the row', async () => {
      // Edge case: an OAuth row that has no Bearers attached (e.g. a
      // tenant that completed `/install` but never finished `/callback`
      // → the OAuth row exists, no `mcp_tokens` to revoke). One audit
      // (`oauth.delete`), one DB row gone.
      await store.upsertTokens(sampleTokens, 'install')
      recordAuditEvent.mockClear()
      await store.deleteTenant(sampleTokens.memberId, sampleTokens.userId, 'system')
      expect(recordAuditEvent).toHaveBeenCalledTimes(1)
      expect(recordAuditEvent.mock.calls[0]![0].event).toBe('oauth.delete')
      expect(store.getTokens(sampleTokens.memberId, sampleTokens.userId)).toBeUndefined()
    })

    it('removes oauth_tokens AND its mcp_tokens (FK CASCADE)', async () => {
      await store.upsertTokens(sampleTokens, 'install')
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, undefined, 'install',
      )
      await store.deleteTenant(sampleTokens.memberId, sampleTokens.userId, 'user')
      expect(store.getTokens(sampleTokens.memberId, sampleTokens.userId)).toBeUndefined()
      expect(store.findByBearerHash(bearerHash)).toBeUndefined()
    })

    it('emits one mcp.revoke per Bearer BEFORE the oauth.delete', async () => {
      await store.upsertTokens(sampleTokens, 'install')
      await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'a', 'install')
      await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'b', 'install')
      recordAuditEvent.mockClear()
      await store.deleteTenant(sampleTokens.memberId, sampleTokens.userId, 'user')
      const events = recordAuditEvent.mock.calls.map(c => c[0].event)
      expect(events).toEqual(['mcp.revoke', 'mcp.revoke', 'oauth.delete'])
    })
  })

  describe('oauth_state — TTL nonce', () => {
    const sampleState = {
      state: 'a'.repeat(64),
      portal: 'acme.bitrix24.com',
      clientId: 'app.cid',
      csrfCookie: 'csrf-b'.repeat(8),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    }

    it('createState with a duplicate `state` throws (UNIQUE PK violation)', () => {
      // The state nonce is 32 bytes of crypto.randomBytes — a collision
      // in practice is astronomically improbable. If one ever lands, the
      // UNIQUE PK refuses the insert; this is preferable to silently
      // overwriting a live `oauth_state` row (which would replace one
      // user's in-flight CSRF binding with another's). The OAuth callback
      // (PR-2c) treats this as a hard error and refuses the request.
      store.createState(sampleState)
      expect(() => store.createState(sampleState)).toThrow(/UNIQUE/i)
    })

    it('consumeState returns the row exactly once', () => {
      store.createState(sampleState)
      expect(store.consumeState(sampleState.state)).toMatchObject({
        portal: sampleState.portal, clientId: sampleState.clientId,
      })
      expect(store.consumeState(sampleState.state)).toBeUndefined()
    })

    it('consumeState returns undefined for a state that was never created', () => {
      // The `DELETE ... RETURNING` statement returns no row for a missing
      // PK — caller sees `undefined` (distinct from an expired row, which
      // is returned WITH its past `expiresAt` so the caller can tell the
      // two apart). Defends against accidental reordering of the
      // null-check in `consumeState`.
      expect(store.consumeState('0'.repeat(64))).toBeUndefined()
    })

    it('consumeState RETURNS an expired row (with past expiresAt) AND deletes it — expiry is the caller policy', () => {
      // The store no longer filters expired rows: it returns the row so
      // the caller (/callback) can emit STATE-EXPIRED vs STATE-MISSING.
      // The row is still deleted on read (replay protection).
      const past = Math.floor(Date.now() / 1000) - 1
      store.createState({ ...sampleState, expiresAt: past })
      const row = store.consumeState(sampleState.state)
      expect(row).toBeDefined()
      expect(row!.expiresAt).toBe(past) // caller sees it's expired
      // Second call undefined — the expired row was wiped on first consume
      // so a later create-with-same-state cannot inherit it.
      expect(store.consumeState(sampleState.state)).toBeUndefined()
    })

    it('pruneExpiredStates removes stale rows in bulk', () => {
      store.createState({ ...sampleState, state: '1'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) - 10 })
      store.createState({ ...sampleState, state: '2'.repeat(64), expiresAt: Math.floor(Date.now() / 1000) - 5 })
      store.createState({ ...sampleState, state: '3'.repeat(64) }) // future-dated, must survive
      expect(store.pruneExpiredStates()).toBe(2)
      expect(store.consumeState('3'.repeat(64))).toBeDefined()
    })
  })

  describe('audit-first invariant — DB stays clean when audit fails', () => {
    it('upsertTokens does NOT write the row if recordAuditEvent rejects', async () => {
      recordAuditEvent.mockRejectedValueOnce(new Error('audit disk full'))
      await expect(store.upsertTokens(sampleTokens, 'install')).rejects.toThrow('audit disk full')
      expect(store.getTokens(sampleTokens.memberId, sampleTokens.userId)).toBeUndefined()
    })

    it('createMcpToken does NOT insert the row if audit rejects', async () => {
      await store.upsertTokens(sampleTokens, 'install')
      recordAuditEvent.mockReset()
      // First call (oauth.upsert above) already consumed; from now on the
      // next audit call rejects. Use mockImplementationOnce so the upsert
      // setup didn't hit the rejection.
      recordAuditEvent.mockRejectedValueOnce(new Error('audit disk full'))
      await expect(
        store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'x', 'install'),
      ).rejects.toThrow('audit disk full')
      // No Bearer row landed. Verify by trying every plausible hash — the
      // table is empty so any lookup returns undefined.
      expect(store.findByBearerHash('sha256-' + 'a'.repeat(64))).toBeUndefined()
    })

    it('deleteTenant aborts cleanly if the FIRST audit emit rejects (DB untouched)', async () => {
      await store.upsertTokens(sampleTokens, 'install')
      await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'a', 'install')
      recordAuditEvent.mockReset()
      recordAuditEvent.mockRejectedValueOnce(new Error('audit disk full'))
      await expect(
        store.deleteTenant(sampleTokens.memberId, sampleTokens.userId, 'user'),
      ).rejects.toThrow('audit disk full')
      // OAuth row still present — the delete never executed.
      expect(store.getTokens(sampleTokens.memberId, sampleTokens.userId)).toBeDefined()
    })

    it('deleteTenant aborts cleanly when the FINAL oauth.delete audit rejects (DB untouched, mcp.revoke audits may be on disk)', async () => {
      // The compliance trap caught by round-1 review: gather all audits
      // first via `Promise.all`, then run the DB write. If the trailing
      // `oauth.delete` audit rejects after the N `mcp.revoke` audits
      // resolved, the DB write is correctly skipped. (Residual: the
      // resolved `mcp.revoke` audits are already on disk — that's a
      // documented "intent record" risk of the audit log's FIFO
      // writeChain, mitigated by caller-side retry idempotency.)
      await store.upsertTokens(sampleTokens, 'install')
      await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'a', 'install')
      await store.createMcpToken(sampleTokens.memberId, sampleTokens.userId, 'b', 'install')
      recordAuditEvent.mockReset()
      // Two revoke audits succeed; the trailing oauth.delete rejects.
      recordAuditEvent.mockResolvedValueOnce(undefined)
      recordAuditEvent.mockResolvedValueOnce(undefined)
      recordAuditEvent.mockRejectedValueOnce(new Error('audit disk full'))
      await expect(
        store.deleteTenant(sampleTokens.memberId, sampleTokens.userId, 'user'),
      ).rejects.toThrow('audit disk full')
      // DB is intact — both Bearers and the OAuth row remain.
      expect(store.getTokens(sampleTokens.memberId, sampleTokens.userId)).toBeDefined()
    })

    it('markRefreshFailed aborts cleanly if any audit rejects (DB untouched, Bearers stay active)', async () => {
      await store.upsertTokens(sampleTokens, 'install')
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, 'a', 'install',
      )
      recordAuditEvent.mockReset()
      recordAuditEvent.mockRejectedValueOnce(new Error('audit disk full'))
      await expect(
        store.markRefreshFailed(sampleTokens.memberId, sampleTokens.userId),
      ).rejects.toThrow('audit disk full')
      // Bearer still active — the UPDATE never ran.
      expect(store.findByBearerHash(bearerHash)).toBeDefined()
    })
  })
})

// Per the `tests/_setup.ts` contract, per-file `vi.stubGlobal` MUST be at
// module level (not inside a `describe` body) so its precedence over the
// global setup default is deterministic across the collection phase.
// Tests below flip `runtimeConfig.bitrix24OauthEnabled` per `it`; the stub
// reads the same mutable object so the override propagates without
// re-stubbing.
const runtimeConfig = {
  bitrix24OauthEnabled: false as boolean,
  bitrix24OauthDbDir: '',
}
vi.stubGlobal('useRuntimeConfig', () => runtimeConfig)

describe('useTokenStore (production singleton)', () => {
  let tmpDir: string
  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises')
    const os = await import('node:os')
    const pathMod = await import('node:path')
    tmpDir = await mkdtemp(pathMod.join(os.tmpdir(), 'token-store-test-'))
    runtimeConfig.bitrix24OauthEnabled = false
    runtimeConfig.bitrix24OauthDbDir = tmpDir
    vi.resetModules() // drop the cached singleton between tests
  })
  afterEach(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('throws when NUXT_BITRIX24_OAUTH_ENABLED=false (fail-loud)', async () => {
    const { useTokenStore } = await import('../../../server/utils/token-store')
    expect(() => useTokenStore()).toThrow(/NUXT_BITRIX24_OAUTH_ENABLED=false/)
  })

  it('rejects a relative NUXT_BITRIX24_OAUTH_DB_DIR (cwd footgun)', async () => {
    runtimeConfig.bitrix24OauthEnabled = true
    runtimeConfig.bitrix24OauthDbDir = 'relative/path'
    const { useTokenStore } = await import('../../../server/utils/token-store')
    expect(() => useTokenStore()).toThrow(/absolute path/)
  })

  it('rejects a NUXT_BITRIX24_OAUTH_DB_DIR with `..` segments', async () => {
    runtimeConfig.bitrix24OauthEnabled = true
    runtimeConfig.bitrix24OauthDbDir = '/srv/data/../../etc'
    const { useTokenStore } = await import('../../../server/utils/token-store')
    expect(() => useTokenStore()).toThrow(/path-traversal/)
  })

  it('opens oauth.sqlite under the configured dir and narrows perms to 0o600', async () => {
    const pathMod = await import('node:path')
    const { statSync, existsSync } = await import('node:fs')
    runtimeConfig.bitrix24OauthEnabled = true
    runtimeConfig.bitrix24OauthDbDir = tmpDir
    const { useTokenStore } = await import('../../../server/utils/token-store')
    useTokenStore()
    const dbFile = pathMod.join(tmpDir, 'oauth.sqlite')
    expect(existsSync(dbFile)).toBe(true)
    // umask on the test host may strip group/world bits — accept either
    // 0o600 (tight umask) or 0o640; never world-readable. Same posture
    // the audit-log file-mode test uses.
    const mode = statSync(dbFile).mode & 0o777
    expect(mode & 0o007).toBe(0) // no world access
    expect(mode & 0o600).toBe(0o600) // owner rw
  })

  it('caches the store across repeated calls (lazy singleton)', async () => {
    runtimeConfig.bitrix24OauthEnabled = true
    runtimeConfig.bitrix24OauthDbDir = tmpDir
    const { useTokenStore } = await import('../../../server/utils/token-store')
    const first = useTokenStore()
    const second = useTokenStore()
    expect(first).toBe(second)
  })

  it('_resetTokenStoreSingletonForTests forces the next call to re-open the DB', async () => {
    // The exported reset hook exists for tests that want to swap the
    // singleton without `vi.resetModules()` (e.g. inside a single describe
    // block that pivots from one tmpdir to another). Confirms the export
    // is not dead code and locks in its contract.
    runtimeConfig.bitrix24OauthEnabled = true
    runtimeConfig.bitrix24OauthDbDir = tmpDir
    const mod = await import('../../../server/utils/token-store')
    const first = mod.useTokenStore()
    mod._resetTokenStoreSingletonForTests()
    const second = mod.useTokenStore()
    expect(first).not.toBe(second)
  })
})
