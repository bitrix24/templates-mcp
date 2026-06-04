import { useTokenStore } from '~/server/utils/token-store'
import { useLogger } from '~/server/utils/logger'

/**
 * One-shot OAuth schema bootstrap at Nitro start.
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
 *   unused, and webhook-only forks see zero behaviour change.
 *
 * Tracked: docs/OAUTH-DESIGN.md §5, §10 rollout step 2.
 */
export default defineNitroPlugin(() => {
  const { bitrix24OauthEnabled } = useRuntimeConfig()
  if (!bitrix24OauthEnabled) return

  const logger = useLogger()
  try {
    useTokenStore() // opens the DB, runs the CREATE TABLE IF NOT EXISTS
    logger.info('OAuth token-store schema bootstrap OK')
  }
  catch (err) {
    logger.error('OAuth token-store schema bootstrap FAILED', { err })
    throw err // propagate so Nitro fails the start — operator sees it in container logs
  }
})
