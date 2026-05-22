import { drainAuditQueue } from '~/server/utils/audit-log'

/**
 * Flushes pending audit-log writes when Nitro is shutting down. Without
 * this, the last few `recordAuditEvent` calls queued at SIGTERM (final
 * `mcp.revoke` on an in-flight uninstall, or the audit line for the
 * 503 response that races the shutdown) would be dropped when the
 * process exits before the in-memory chain settles.
 *
 * Limit: a SIGKILL (or power loss) bypasses the `close` hook entirely, so
 * records still queued in the in-memory chain are lost. Closing that gap
 * needs `O_SYNC` on each write — see the durability caveat in
 * `server/utils/audit-log.ts`.
 *
 * Tracked: issue #61.
 */
export default defineNitroPlugin((nitro) => {
  nitro.hooks.hook('close', async () => {
    await drainAuditQueue()
  })
})
