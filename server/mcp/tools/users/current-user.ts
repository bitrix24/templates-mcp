import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import { callV2 } from '~/server/utils/sdk-helpers'

/**
 * Returns the Bitrix24 user identity the server is currently acting as.
 * Useful as a smoke test for AI agents to confirm the MCP is wired correctly.
 *
 * Bitrix24 REST: https://apidocs.bitrix24.com/api-reference/user/user-current.html
 * (v2 namespace — `user.*` predates v3 and has no v3 equivalent.)
 */
interface CurrentUserResponse {
  ID?: string | number
  NAME?: string
  LAST_NAME?: string
}

export default defineMcpTool({
  name: 'b24_user_me',
  description:
    'Get the Bitrix24 user under whose identity the server acts — the OAuth-consenting user when OAuth is configured (multi-tenant HTTP deploys, or DXT bundles built with OAuth credentials), the webhook owner otherwise. Use this as a connectivity check or when you need the operator id/name before any subsequent Bitrix24 calls.',
  inputSchema: {},
  handler: async () => {
    const b24 = useBitrix24Tenant()
    const user = await callV2<CurrentUserResponse>(
      b24,
      'user.current',
      {},
      'Failed to fetch current Bitrix24 user',
    )

    if (!user) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Bitrix24 returned no user — verify the webhook URL is valid and not revoked.',
          },
        ],
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          // Explicit `?? null` on optional fields: JSON.stringify drops
          // undefined keys, which makes the agent guess whether the field
          // was absent or unknown. `null` is unambiguous.
          text: JSON.stringify({
            id: user.ID ?? null,
            name: user.NAME ?? null,
            lastName: user.LAST_NAME ?? null,
          }),
        },
      ],
    }
  },
})
