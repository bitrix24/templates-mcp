import { drainAuditQueue } from '~/server/utils/audit-log'

/**
 * Flushes pending audit-log writes when Nitro is shutting down. Without
 * this, the last few `recordAuditEvent` calls queued at SIGTERM (final
 * `mcp.revoke` on an in-flight uninstall, or the audit line for the
 * 503 response that races the shutdown) would be dropped when the
 * process exits before the in-memory chain settles.
 *
 * Belt-and-braces: the chain is process-local. A SIGKILL still drops
 * unflushed records; for that, the operator needs `O_SYNC` (see the
 * durability caveat in `server/utils/audit-log.ts`).
 *
 * Tracked: issue #61.
 */
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', async () => {
    await drainAuditQueue()
  })
})
