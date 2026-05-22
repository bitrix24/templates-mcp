import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Compliance-grade JSONL audit trail for OAuth and Bearer-token mutations
 * (issue #61, `docs/OAUTH-DESIGN.md §11` P1-pre-enterprise — **note: §11 of
 * the OAuth design doc lives on PR #58 (`claude/oauth-design`) and is not
 * yet in `main`; the section will become discoverable when #58 merges**).
 *
 * Why this exists — operating a multi-tenant OAuth server is a credential-
 * adjacent surface. GDPR data-subject access requests, SOC2 control
 * evidence, and breach forensics all need a tamper-evident answer to "who
 * had access to which portal between dates X and Y, and who revoked them".
 * The token store alone answers "right now"; the audit log answers history.
 *
 * Shape — one JSON object per line, daily rotation. The rotation key is
 * the **UTC** date (from `toISOString()`), so the filename is independent
 * of server timezone — an operator in UTC+13 sees the file flip at their
 * local 13:00, which is the price of a single consistent boundary.
 *
 *
 *   /data/audit/2026-05-19.jsonl
 *     {"ts":"…","event":"oauth.upsert","portal":"…","userId":"…","actor":"install"}
 *     {"ts":"…","event":"mcp.create","portal":"…","userId":"…","mcpTokenId":"…","actor":"install"}
 *     {"ts":"…","event":"mcp.revoke","portal":"…","userId":"…","mcpTokenId":"…","actor":"user"}
 *
 * Path — `process.env.NUXT_AUDIT_DIR` if set and non-empty, else
 * `/data/audit/`. Read directly from `process.env` (not via Nuxt's
 * `useRuntimeConfig()`) so the logger keeps working in contexts where the
 * Nitro runtime is not bootstrapped — fail-mode forensics, CLI scripts,
 * and tests. Path-traversal segments (`..`) are rejected at read time.
 *
 * Caller contract — write failures (disk full, EACCES, unwritable mount)
 * surface as a rejected promise. Callers **MUST** treat the rejection as
 * a hard failure for the operation being audited ("no audit, no action" —
 * the right posture for the surface this guards). Example:
 *
 * ```ts
 * try {
 *   await recordAuditEvent({event: 'mcp.create', …})
 *   await createMcpToken(row)        // only mint the Bearer if the audit landed
 * } catch (err) {
 *   logger.error({err}, 'audit write failed; aborting mcp.create')
 *   throw new HttpError(503, 'audit unavailable, try again')
 * }
 * ```
 *
 * Concurrency — a process-local promise chain serialises writes so two
 * concurrent {@link recordAuditEvent} calls cannot interleave bytes on the
 * `appendFile` syscall. Bytes land in the order callbacks register. Multi-
 * instance / cluster-mode deployments need a shared sink (Postgres,
 * syslog, S3); that's out of scope for v1 and tracked in
 * `docs/OAUTH-DESIGN.md §11` HA-store item.
 *
 * Durability caveat — `appendFile` does not `fdatasync`; a hard kernel
 * crash within milliseconds of a write can lose the last record. Adding
 * `O_SYNC` triples write latency on commodity SSDs and is left to a later
 * `AUDIT_FSYNC=true` flag if compliance requires it.
 *
 * Permission caveat — `appendFile`/`mkdir` apply mode only on creation; if
 * the dir/file already exists with broader perms, we do NOT narrow them.
 * Deploy-time `chmod 0750 /data/audit && chmod 0640 /data/audit/*.jsonl`
 * is the canonical fix; the file mode here is a fall-back for fresh
 * installs.
 *
 * Operator note — files grow forever. Operators MUST configure log
 * rotation and retention (`logrotate`, cron + `find -mtime`, or equivalent).
 * The daily-rotation filename keeps the operator's job trivial; this module
 * never deletes anything.
 *
 * PII / GDPR — `ip` and `ua` are personal data (GDPR Art. 4(1)). The lawful
 * basis for recording them is legitimate interest in security / abuse
 * forensics (Art. 6(1)(f)) and SOC2 access-logging. Retention is therefore
 * NOT open-ended: operators MUST cap it (recommended 90 days, max 12 months
 * absent a longer legal-hold requirement) via their rotation policy. The
 * full data-subject-request + retention runbook lands in `docs/SECURITY-
 * AUDIT.md` with PR-2 — tracked in issue #66. Forks that do not need IP/UA
 * forensics should simply omit those fields at the call site.
 *
 * Secret hygiene — `mcpTokenId` MUST be the sha256 prefix of the Bearer
 * (token-store discipline), never raw token material. A defensive regex
 * gate in {@link recordAuditEvent} rejects values that don't match the
 * `sha256-<hex>` shape. The test suite further asserts no token-shaped
 * string ever appears in the file.
 *
 * `docs/SECURITY-AUDIT.md` will gain a dedicated "ALS tenant isolation +
 * audit log" section when PR-2 lands and the tenant surface becomes real;
 * tracked in issue #66 to keep this PR focused on the primitive.
 */

/**
 * Type of change in the token store — answers "what happened".
 */
export type AuditEventKind =
  | 'oauth.upsert' // OAuth row created on install OR rewritten on refresh
  | 'oauth.delete' // OAuth row removed on uninstall / hard revoke
  | 'mcp.create' //   Bearer minted on install
  | 'mcp.revoke' //   Bearer revoked on uninstall / user logout / rotation

/**
 * Initiator of the mutation — answers "who did it". Kept distinct from
 * {@link AuditEventKind} so a single event ("oauth.upsert") can be filed
 * against different principals ("install" vs. "refresh") without losing
 * the distinction during forensics.
 */
export type AuditActor =
  | 'install' //  Initial OAuth callback (/api/oauth/callback)
  | 'refresh' //  Token refresh path (lazy, triggered by expiring access_token)
  | 'user' //     User-initiated action (logout, manual revoke)
  | 'system' //   Scheduled / automatic (TTL expiry, markRefreshFailed)

/**
 * One audit record. Marked `Readonly` to signal value-object semantics —
 * mutating after the call is meaningless because the record is captured
 * synchronously at the top of {@link recordAuditEvent} and queued.
 */
export type AuditEvent = Readonly<{
  /** Type of change in the token store. */
  event: AuditEventKind
  /** Portal host (e.g. `acme.bitrix24.com`) or `member_id` from OAuth payload. */
  portal: string
  /** Bitrix24 user id (`access_token` owner). */
  userId: string
  /** sha256-prefix of the Bearer — `sha256-<hex>`. Never the raw value. Required for `mcp.*`. */
  mcpTokenId?: string
  /** Principal who initiated the mutation. */
  actor: AuditActor
  /** Client IP from `X-Forwarded-For` or socket. Optional — install path only. */
  ip?: string
  /** User-Agent header. Optional — install path only. */
  ua?: string
}>

/**
 * Internal record shape — what's actually serialised. `ts` is added here
 * (not accepted from the caller) to prevent backdating.
 */
interface AuditRecord extends Omit<AuditEvent, 'mcpTokenId' | 'ip' | 'ua'> {
  ts: string
  mcpTokenId?: string
  ip?: string
  ua?: string
}

const DEFAULT_AUDIT_DIR = '/data/audit'
const DIR_MODE = 0o750
const FILE_MODE = 0o640

/**
 * `sha256-` followed by 1-64 lowercase hex chars. Tight enough to refuse
 * a raw Bearer (which is 32+ alnum with no prefix) and a raw refresh
 * token, loose enough to accept both full sha256 hashes and short
 * prefixes used in dev.
 */
const MCP_TOKEN_ID_RE = /^sha256-[a-f0-9]{1,64}$/

// Length caps for free-text fields (DoS / disk-blowup guard). Generous vs.
// any legitimate value; truncation never drops the event.
const MAX_PORTAL_LEN = 253 // RFC 1035 hostname max
const MAX_USERID_LEN = 64
const MAX_IP_LEN = 64 // IPv6 + zone id fits comfortably
const MAX_UA_LEN = 512

/**
 * Resolves the directory writes land in. `NUXT_AUDIT_DIR` wins if non-empty
 * after trim; otherwise falls back to {@link DEFAULT_AUDIT_DIR}. Throws on a
 * value containing `..` segments (path-traversal guard) or one that is not
 * absolute (a relative value would resolve against `process.cwd()`, which is
 * unpredictable under Docker / systemd — fail loud instead). Exported so
 * tests can verify the resolver without touching the host filesystem (ESM
 * forbids spying on `node:fs/promises`).
 *
 * The validated value is returned as-is. `path.resolve` is intentionally
 * avoided — on Windows it prepends the current drive letter, converting
 * `/audit` to `C:\audit`. `path.join` in {@link recordAuditEvent} normalises
 * double slashes when building the per-day filename, so no normalisation is
 * needed here.
 *
 * Operator note: point this at a **dedicated** directory. The logger only
 * ever appends its own `YYYY-MM-DD.jsonl` files (never overwrites), but a
 * shared directory mixes audit records with unrelated files and complicates
 * retention/rotation.
 */
export function resolveAuditDir(): string {
  const fromEnv = process.env.NUXT_AUDIT_DIR?.trim()
  if (!fromEnv || fromEnv.length === 0) return DEFAULT_AUDIT_DIR

  // Reject `..` segments — checked before isAbsolute so that relative
  // traversal paths (e.g. `../../etc/cron.d`) surface as "path-traversal"
  // rather than merely "not absolute". Split on both '/' and '\' so the
  // guard works on Windows dev machines as well as Linux production.
  if (fromEnv.split(/[/\\]/).some(seg => seg === '..')) {
    throw new Error(`NUXT_AUDIT_DIR rejected: path-traversal segment "..": ${fromEnv}`)
  }

  // path.isAbsolute is intentionally platform-aware here: on Linux (production)
  // it accepts POSIX absolute paths (/data/audit); on Windows (dev/test) it
  // also accepts Windows absolute paths (C:\...\Temp\audit-log-test-xxx) so
  // the test suite can use os.tmpdir() without special-casing.
  if (!path.isAbsolute(fromEnv)) {
    throw new Error(`NUXT_AUDIT_DIR rejected: must be an absolute path, got: ${fromEnv}`)
  }

  return fromEnv
}

let writeChain: Promise<void> = Promise.resolve()

export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  // Explicit destructure (not spread) so a sneaky caller cannot smuggle a
  // backdated `ts` or unknown extra fields into the record. Also rules
  // out enumerable-prototype injection: `JSON.stringify` ignores inherited
  // properties, but the destructure removes any doubt.
  const { event: kind, portal, userId, mcpTokenId, actor, ip, ua } = event

  if (mcpTokenId !== undefined && !MCP_TOKEN_ID_RE.test(mcpTokenId)) {
    throw new Error(
      `recordAuditEvent: mcpTokenId must match sha256-<hex>; got a value that does not — refusing to log to avoid leaking raw token material`,
    )
  }

  // Cap free-text fields so a hostile/buggy caller can't blow up line size
  // (and disk) with a multi-MB User-Agent or portal string. Caps are well
  // above any legitimate value: hostname max is 253 (RFC 1035), UA strings
  // are realistically <512. Truncation is preferable to rejection — never
  // drop an audit event over an oversized cosmetic field.
  const record: AuditRecord = {
    ts: new Date().toISOString(),
    event: kind,
    portal: portal.slice(0, MAX_PORTAL_LEN),
    userId: userId.slice(0, MAX_USERID_LEN),
    ...(mcpTokenId !== undefined ? { mcpTokenId } : {}),
    actor,
    ...(ip !== undefined ? { ip: ip.slice(0, MAX_IP_LEN) } : {}),
    ...(ua !== undefined ? { ua: ua.slice(0, MAX_UA_LEN) } : {}),
  }
  const line = `${JSON.stringify(record)}\n`
  const dir = resolveAuditDir()
  const file = path.join(dir, `${record.ts.slice(0, 10)}.jsonl`)

  const next = writeChain.then(async () => {
    // `mkdir` runs on every write (not cached): at audit volume — a handful
    // of events per OAuth install/refresh/revoke — the extra syscall is
    // free, and it self-heals if the directory is removed out from under
    // the process (volume remount, operator rm). Caching the "ensured" set
    // would trade that resilience for an optimisation the workload doesn't
    // need.
    await mkdir(dir, { recursive: true, mode: DIR_MODE })
    await appendFile(file, line, { mode: FILE_MODE })
  })

  // Keep the chain alive even if this write rejects — a single failure
  // should not poison every subsequent recordAuditEvent call. The caller
  // still sees the rejection via `next`, so fail-closed semantics are
  // preserved at the call site.
  writeChain = next.catch(() => undefined)

  return next
}

/**
 * Test / shutdown-hook only — drains the in-flight write queue. Production
 * call sites MUST NOT depend on this from inside a request handler; it
 * exists so (a) test teardown can assert all writes hit disk before
 * reading the file back and (b) a Nitro `close` hook can flush pending
 * audit records before the process exits.
 *
 * The companion `server/plugins/audit-drain.ts` wires this into Nitro's
 * shutdown lifecycle so writes queued at SIGTERM don't get dropped.
 */
export async function drainAuditQueue(): Promise<void> {
  await writeChain
}
