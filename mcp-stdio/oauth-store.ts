import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getUserDataDir } from './user-data-dir'

const STORE_FILENAME = 'oauth.json'

export interface OAuthTokens {
  memberId: string
  userId: number
  portalDomain: string
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  scope: string
  /**
   * Set to `true` after a refresh fails with `invalid_grant` (operator
   * uninstalled the app on the portal side, or revoked the refresh token
   * out of band). Sticky — only cleared by a fresh OOB exchange.
   * Mirrors the HTTP-side `markRefreshFailed` semantic.
   */
  refreshInvalid: boolean
}

/**
 * Single-tenant JSON file store for OAuth tokens. DXT runs per-machine
 * per-user, so there is exactly one tenant per install — the file holds
 * one row, not a table. Atomic write via tmp + rename to avoid torn
 * writes if the process is killed mid-update; file mode 0o600 so other
 * accounts on the same machine can't read the tokens.
 *
 * NOT thread-safe across concurrent stdio servers — Claude Desktop spawns
 * one extension process at a time, and the OOB refresh happens inline on
 * the request that needed a refresh. If a future DXT host runs the
 * bundle concurrently, this needs a fcntl lock; not worth the
 * cross-platform complexity today.
 */
export class OAuthStore {
  private readonly path: string

  constructor(dataDirOverride?: string) {
    this.path = join(getUserDataDir(dataDirOverride), STORE_FILENAME)
  }

  read(): OAuthTokens | null {
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    try {
      const parsed = JSON.parse(raw) as Partial<OAuthTokens>
      if (
        typeof parsed.memberId !== 'string'
        || typeof parsed.userId !== 'number'
        || typeof parsed.portalDomain !== 'string'
        || typeof parsed.accessToken !== 'string'
        || typeof parsed.refreshToken !== 'string'
        || typeof parsed.accessExpiresAt !== 'number'
        || typeof parsed.scope !== 'string'
      ) {
        return null
      }
      return {
        memberId: parsed.memberId,
        userId: parsed.userId,
        portalDomain: parsed.portalDomain,
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        accessExpiresAt: parsed.accessExpiresAt,
        scope: parsed.scope,
        refreshInvalid: parsed.refreshInvalid === true,
      }
    }
    catch {
      return null
    }
  }

  /**
   * Persist a complete token row. Atomic: writes to `<path>.tmp` with
   * mode 0o600, then renames over the target. `rename(2)` is atomic on
   * the same filesystem; cross-volume is not a concern because both
   * paths share `dataDir`.
   */
  write(row: OAuthTokens): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(row, null, 2), { mode: 0o600 })
    // `writeFileSync({ mode })` is honoured only on file creation; if
    // `.tmp` was left over from a prior crashed write, the mode bits
    // are inherited. Re-chmod defensively.
    try { chmodSync(tmp, 0o600) }
    catch { /* best-effort on platforms without POSIX permissions */ }
    renameSync(tmp, this.path)
  }

  /**
   * Stamp `refreshInvalid: true` without touching the rest of the row.
   *
   * Follow-up S2 (#239 /review): TOCTOU guard. The refresh handler holds
   * a snapshot of the row from the START of the refresh attempt; by the
   * time `invalid_grant` comes back, a concurrent successful re-onboarding
   * (`exchangeOobCode` → `store.write`) could have replaced the row with
   * a fresh refresh token. Without this guard we'd stamp invalid on the
   * fresh row and lock the user out one second after they fixed it.
   *
   * Caller passes the `refreshToken` that the failing request used; we
   * read the current row and only stamp if they still match. A mismatch
   * means the row was rotated mid-flight — leave it alone.
   *
   * `expectedRefreshToken` is optional for the existing callers that don't
   * need the guard (tests, future bulk paths); when omitted the legacy
   * unconditional behaviour applies.
   */
  markRefreshFailed(expectedRefreshToken?: string): void {
    const row = this.read()
    if (!row) return
    if (expectedRefreshToken !== undefined && row.refreshToken !== expectedRefreshToken) return
    this.write({ ...row, refreshInvalid: true })
  }

  /**
   * Path getter — only here for tests / audit-log placement. Callers
   * shouldn't be reading the file directly.
   */
  get filePath(): string { return this.path }
}
