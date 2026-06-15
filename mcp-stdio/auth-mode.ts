import type { TypeB24 } from '@bitrix24/b24jssdk'
import { _setStdioClientOverride } from '~/server/utils/bitrix24-tenant'
import { useLogger } from '~/server/utils/logger'
import { buildOAuthClient } from './oauth-client'
import { OAuthStore } from './oauth-store'

export type DxtAuthMode =
  | 'webhook'             // webhook URL configured, OAuth disabled or unavailable
  | 'oauth-active'        // OAuth configured + tokens on disk + not invalid
  | 'oauth-onboarding'    // OAuth configured + no usable tokens → expose paste-code

export interface DxtAuthConfig {
  webhookUrl: string
  oauthClientId: string
  oauthClientSecret: string
  portalHost: string
  dataDirOverride?: string
}

/**
 * Pick the auth mode at stdio boot and wire `useBitrix24Tenant()` to
 * the right client. Decision tree (Q3 of #207 — "OAuth wins if usable;
 * else webhook"):
 *
 *   1. Are all THREE OAuth fields configured (`portalHost`, `oauthClientId`,
 *      `oauthClientSecret`)? They flow from Claude Desktop's `user_config`
 *      block at runtime — NOT baked into the bundle at build time (see
 *      #247; the original #207 design baked CLIENT_ID/SECRET via esbuild
 *      `define`, walked back because a `.dxt` is a zip and bake-time
 *      gives zero security benefit). Partial fill (2 of 3) is treated
 *      as not-set: the gate is `!!(clientId && clientSecret && portalHost)`.
 *        - No → no OAuth path possible. If webhook URL is set, mode =
 *          'webhook' (existing path). Otherwise this returns null and
 *          the caller fails fast: nothing to do.
 *
 *   2. Are tokens on disk and not marked invalid?
 *        - Yes → mode = 'oauth-active'. Build the client now and
 *          register an override that returns it.
 *        - No → mode = 'oauth-onboarding'. Register a throwing override
 *          so any tool call surfaces the "run paste-code first" hint.
 *          The paste-code tool itself does NOT go through the override.
 *
 * Returns the chosen mode (or null if unconfigured). Callers use it for
 * the stderr log line and to decide whether to register the paste-code
 * tool.
 */
export function resolveAuthMode(cfg: DxtAuthConfig): DxtAuthMode | null {
  const oauthReady = !!(cfg.oauthClientId && cfg.oauthClientSecret && cfg.portalHost)

  if (oauthReady) {
    const store = new OAuthStore(cfg.dataDirOverride)
    const row = store.read()
    if (row && !row.refreshInvalid) {
      let cached: TypeB24 | null = null
      _setStdioClientOverride(() => {
        if (!cached) {
          cached = buildOAuthClient({
            clientId: cfg.oauthClientId,
            clientSecret: cfg.oauthClientSecret,
            store,
            dataDirOverride: cfg.dataDirOverride,
          })
        }
        return cached
      })
      void useLogger().info('dxt.auth.mode', {
        mode: 'oauth-active',
        memberId: row.memberId,
        userId: row.userId,
        portalDomain: row.portalDomain,
      })
      return 'oauth-active'
    }

    // Onboarding: any tool call other than paste-code surfaces this.
    _setStdioClientOverride(() => {
      const reason = row?.refreshInvalid
        ? 'OAuth refresh token has been revoked on the portal side. '
        : 'OAuth onboarding has not been completed yet. '
      throw new Error(
        reason
        + 'Open the URL printed in the extension log, sign in to your Bitrix24 portal, '
        + 'copy the short code shown on the consent page, and call '
        + '`bx24mcp_oauth_paste_code` with it as the `code` argument.',
      )
    })
    void useLogger().info('dxt.auth.mode', {
      mode: 'oauth-onboarding',
      portalHost: cfg.portalHost,
      reason: row?.refreshInvalid ? 'refresh-invalid' : 'no-tokens',
    })
    return 'oauth-onboarding'
  }

  if (cfg.webhookUrl) {
    // Leave the override null — `useBitrix24Tenant()` falls through to
    // the existing webhook singleton. No log line: the absence of an
    // override IS the "default webhook" mode, identical to v0.2.0.
    void useLogger().info('dxt.auth.mode', { mode: 'webhook' })
    return 'webhook'
  }

  return null
}
