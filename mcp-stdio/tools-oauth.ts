import type { TypeB24 } from '@bitrix24/b24jssdk'
import { z } from 'zod'
import { _setStdioClientOverride } from '~/server/utils/bitrix24-tenant'
import { useLogger } from '~/server/utils/logger'
import { buildOAuthClient, buildOnboardingUrl, exchangeOobCode } from './oauth-client'
import { OAuthStore } from './oauth-store'

/**
 * Stdio-only meta tool: completes the OOB OAuth onboarding by exchanging
 * the short code the user copied from Bitrix24's consent page for an
 * access/refresh token pair. After a successful exchange the dispatcher
 * override is replaced with a live OAuth client so subsequent tool calls
 * succeed without restarting Claude Desktop.
 *
 * This tool is registered only when the stdio bundle boots into
 * `oauth-onboarding` mode (see `auth-mode.ts`). It is intentionally not
 * declared in `server/mcp/tools/**`: the HTTP server uses the proper
 * `/api/oauth/install` → `/api/oauth/callback` flow and has no need for
 * an out-of-band paste path; surfacing it there would only confuse
 * agents and clutter the tool catalogue.
 */
export function buildPasteCodeTool(args: {
  clientId: string
  clientSecret: string
  portalHost: string
  dataDirOverride?: string
}) {
  return {
    name: 'bx24mcp_oauth_paste_code',
    title: 'Paste Bitrix24 OAuth consent code',
    description:
      'Completes the one-time Bitrix24 OAuth setup for this DXT install. '
      + 'Provide the short code displayed on the Bitrix24 consent page (the URL of '
      + `which was printed in the extension log at startup: https://${args.portalHost}/oauth/authorize/?...). `
      + 'The code is valid for ~30 seconds — paste it promptly. After a successful exchange '
      + 'every other Bitrix24 tool acts under the consenting user’s identity and permissions '
      + 'on this machine. Run again only if you need to re-onboard (e.g. after the refresh token '
      + 'was revoked on the portal side).',
    inputSchema: { code: z.string().trim().min(1, 'code is required') },
    handler: async (input: { code: string }) => {
      const store = new OAuthStore(args.dataDirOverride)
      const row = await exchangeOobCode({
        code: input.code,
        clientId: args.clientId,
        clientSecret: args.clientSecret,
        store,
        dataDirOverride: args.dataDirOverride,
      })

      // Swap the onboarding-mode throwing override for a live OAuth
      // client so the next tool call in this session works.
      let cached: TypeB24 | null = null
      _setStdioClientOverride(() => {
        if (!cached) {
          cached = buildOAuthClient({
            clientId: args.clientId,
            clientSecret: args.clientSecret,
            store,
            dataDirOverride: args.dataDirOverride,
          })
        }
        return cached
      })

      void useLogger().info('dxt.oauth.onboarded', {
        memberId: row.memberId,
        userId: row.userId,
        portalDomain: row.portalDomain,
      })

      return {
        ok: true,
        portalDomain: row.portalDomain,
        userId: row.userId,
        accessExpiresAt: row.accessExpiresAt,
        message: `OAuth onboarding complete. Acting as Bitrix24 user ${row.userId} on ${row.portalDomain}.`,
      }
    },
  }
}

/** Re-export so `server.ts` can build the URL for the startup log line. */
export { buildOnboardingUrl }
