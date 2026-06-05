import { useTokenStore } from '~/server/utils/token-store'
import { useLogger } from '~/server/utils/logger'

/**
 * One-shot OAuth schema bootstrap at Nitro start + periodic
 * `oauth_state` pruning (issue #211).
 *
 * Why a plugin (and not lazy-on-first-call alone):
 *   `useTokenStore()` would create the schema on first request anyway via
 *   `bootstrapSchema`. But triggering it at boot means a misconfigured
 *   `NUXT_BITRIX24_OAUTH_DB_DIR` (unwritable mount, missing volume,
 *   wrong permissions) fails the container's healthcheck loudly, instead
 *   of surfacing as a 500 on the first OAuth request hours later.
 *
 * Flag-gated:
 *   When `NUXT_BITRIX24_OAUTH_ENABLED=false` (the default) this plugin
 *   does nothing — the SQLite file is never created, the volume stays
 *   unused, the prune timer is not armed, and webhook-only forks see
 *   zero behaviour change.
 *
 * Periodic prune (issue #211):
 *   `oauth_state` rows live 5 minutes (the install→callback TTL). Rows
 *   that never get consumed (browser closed, link not clicked, `/install`
 *   spam from a public deployment) accumulate until something calls
 *   `pruneExpiredStates()`. A 5-minute `setInterval` keeps the table
 *   bounded: at worst a row lives 10 minutes total (5 min TTL + up to
 *   5 min wait before the next prune tick). The DELETE itself uses the
 *   `idx_state_expires` index — constant cost regardless of table size.
 *
 * Shutdown:
 *   The interval is cleared on Nitro's `close` hook so a hot-reload in
 *   dev or a SIGTERM in prod doesn't leave a zombie timer holding the
 *   process alive. The handler captures the timer ID locally so a
 *   future plugin reload constructs a fresh one.
 *
 * Tracked: docs/OAUTH-DESIGN.md §5 + §11, issue #211.
 */

/**
 * @internal — exported as a constant for testability; production code
 * must not import this.
 */
export const PRUNE_INTERVAL_MS = 5 * 60 * 1000

export default defineNitroPlugin((nitro) => {
  const { bitrix24OauthEnabled } = useRuntimeConfig()
  if (!bitrix24OauthEnabled) return

  const logger = useLogger()
  let store: ReturnType<typeof useTokenStore>
  try {
    store = useTokenStore() // opens the DB, runs the CREATE TABLE IF NOT EXISTS
    void logger.info('OAuth token-store schema bootstrap OK')
  }
  catch (err) {
    void logger.error('OAuth token-store schema bootstrap FAILED', { err })
    throw err // propagate so Nitro fails the start — operator sees it in container logs
  }

  // Arm the prune timer. `unref()` so a hanging timer doesn't keep the
  // process alive on SIGTERM if the close hook didn't fire (defensive).
  const timer = setInterval(() => {
    try {
      const pruned = store.pruneExpiredStates()
      if (pruned > 0) void logger.info('oauth.state.prune.ok', { rows: pruned })
    }
    catch (err) {
      // Log-and-continue: a transient SQLite error during prune (disk
      // full, lock contention) shouldn't kill the Nitro process. The
      // next tick retries on its own.
      void logger.error('oauth.state.prune.fail', { err })
    }
  }, PRUNE_INTERVAL_MS)
  timer.unref?.()

  nitro.hooks.hook('close', () => clearInterval(timer))
})
