import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import { useTokenStore } from '~/server/utils/token-store'
import { getTenantContext } from '~/server/utils/request-context'

/**
 * Operator-facing meta-tool — answers "which devices am I still
 * authorised on?" against the active Bearers a tenant minted.
 *
 * Only meaningful under HTTP multi-tenant OAuth: there's exactly one
 * Bearer per `(memberId, userId)` per install, minted at consent time
 * and pasted into one MCP client. In webhook-only mode and in DXT
 * (which has its own single-tenant file store) the concept of "list
 * Bearers" doesn't apply — the tool refuses with a friendly hint.
 *
 * NEVER returns the raw Bearer or its full SHA-256 — only the first 8
 * hex characters of the hash, enough to disambiguate "the one I called
 * Laptop" against what the user pasted into Claude/Cursor and useless
 * as a credential by itself. Closes #212.
 */
export default defineMcpTool({
  name: 'bx24mcp_list_session',
  description:
    'List the active Bearer sessions issued to your Bitrix24 OAuth tenant on this MCP server. Returns one row per session that you have NOT revoked, with the label you gave it at mint time, when it was created, and the first 8 hex characters of its SHA-256 hash (enough to match the label against what you pasted into Claude/Cursor; useless as a credential). The raw Bearer is shown only once at mint time and is never persisted. Use this when you need to audit which devices still hold a valid session. Only works on multi-tenant OAuth deployments — in webhook or DXT mode it returns a friendly note that the concept does not apply.',
  inputSchema: {},
  handler: async () => {
    const { bitrix24OauthEnabled } = useRuntimeConfig()
    if (!bitrix24OauthEnabled) {
      return {
        content: [{
          type: 'text' as const,
          text: 'bx24mcp_list_session only applies to multi-tenant OAuth deployments. This server runs in webhook mode (or stdio/DXT) — there is one shared service account or one per-machine token, not a list of issued Bearer sessions.',
        }],
        isError: true,
      }
    }

    const tenant = getTenantContext()
    if (!tenant) {
      return {
        content: [{
          type: 'text' as const,
          text: 'bx24mcp_list_session requires a tenant context — the request must arrive with a valid Bearer that the middleware resolves to a tenant. If you are seeing this from the MCP Inspector or a dry-run, attach an Authorization header.',
        }],
        isError: true,
      }
    }

    const userIdNum = Number.parseInt(tenant.userId, 10)
    if (!Number.isFinite(userIdNum)) {
      return {
        content: [{ type: 'text' as const, text: 'tenant userId is not a valid integer' }],
        isError: true,
      }
    }

    const sessions = useTokenStore().listMcpTokens(tenant.memberId, userIdNum)
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          memberId: tenant.memberId,
          userId: userIdNum,
          count: sessions.length,
          sessions,
        }, null, 2),
      }],
    }
  },
})
