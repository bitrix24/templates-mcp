import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { getUserDataDir } from './user-data-dir'

const LOG_FILENAME = 'audit.log'

/**
 * Event types — subset of the HTTP-side taxonomy
 * (`server/utils/audit-log.ts`). DXT is single-tenant so only the events
 * relevant to a single user's OAuth lifecycle are emitted:
 *
 *   - `oauth.upsert.exchange`   — first-time OOB code exchange succeeded.
 *   - `oauth.upsert.refresh`    — silent refresh on 401 succeeded.
 *   - `oauth.fail.invalid-grant`— refresh returned `invalid_grant`; the
 *                                  tokens have been marked invalid and
 *                                  the user must re-onboard.
 *   - `oauth.fail.transient`    — network or 5xx during refresh; tokens
 *                                  unchanged, next call retries.
 *   - `oauth.delete`            — operator wiped the token file via tool.
 */
export type DxtAuditEvent =
  | 'oauth.upsert.exchange'
  | 'oauth.upsert.refresh'
  | 'oauth.fail.invalid-grant'
  | 'oauth.fail.transient'
  | 'oauth.delete'

export interface DxtAuditEntry {
  event: DxtAuditEvent
  ts: number
  memberId?: string
  userId?: number
  /** Optional cause / HTTP status / SDK error string — never a token. */
  detail?: string
}

/**
 * Append a single JSONL line to `<user-data>/audit.log`. Best-effort —
 * a write failure (read-only FS, permission denied) logs to stderr but
 * does NOT throw: an audit failure must never break a working OAuth
 * exchange or refresh, otherwise an unwritable disk turns into a
 * denial-of-service.
 */
export function recordDxtAuditEvent(
  entry: Omit<DxtAuditEntry, 'ts'>,
  dataDirOverride?: string,
): void {
  const line = JSON.stringify({ ...entry, ts: Math.floor(Date.now() / 1000) }) + '\n'
  try {
    const dir = getUserDataDir(dataDirOverride)
    appendFileSync(join(dir, LOG_FILENAME), line, { mode: 0o600 })
  }
  catch (err) {
    process.stderr.write(`audit-log write failed: ${(err as Error).message}\n`)
  }
}
