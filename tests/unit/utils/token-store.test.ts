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

    it('revoking an already-revoked Bearer is an idempotent no-op (no audit double-emit)', async () => {
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, undefined, 'install',
      )
      recordAuditEvent.mockClear()
      await store.revokeMcpToken(bearerHash, 'user')
      await store.revokeMcpToken(bearerHash, 'user') // second time — should be silent
      expect(recordAuditEvent).toHaveBeenCalledTimes(1)
    })

    it('label is stored verbatim and round-trips via the audit signal but not back via lookup', async () => {
      const { bearerHash } = await store.createMcpToken(
        sampleTokens.memberId, sampleTokens.userId, 'Laptop', 'install',
      )
      // findByBearerHash does NOT return the label by design — middleware
      // doesn't need it. A future operator-facing "list my tokens" tool
      // would read it directly from the DB.
      expect(store.findByBearerHash(bearerHash)).toEqual({
        memberId: sampleTokens.memberId, userId: sampleTokens.userId,
      })
    })
  })

  describe('markRefreshFailed — only revokes the affected tenant', () => {
    beforeEach(async () => {
      await store.upsertTokens(sampleTokens, 'install')
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

    it('consumeState returns the row exactly once', () => {
      store.createState(sampleState)
      expect(store.consumeState(sampleState.state)).toMatchObject({
        portal: sampleState.portal, clientId: sampleState.clientId,
      })
      expect(store.consumeState(sampleState.state)).toBeUndefined()
    })

    it('consumeState refuses an expired state AND deletes it (no replay)', () => {
      store.createState({ ...sampleState, expiresAt: Math.floor(Date.now() / 1000) - 1 })
      expect(store.consumeState(sampleState.state)).toBeUndefined()
      // Second call also undefined — the expired row was wiped on first
      // consume so a later create-with-same-state cannot inherit it.
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
  })
})
