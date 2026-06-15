#!/usr/bin/env node
/**
 * Stdio MCP entrypoint — what Claude Desktop launches when the user
 * installs the `.dxt` bundle.
 *
 * Pipeline:
 *   1. Install Nuxt-runtime shims (`useRuntimeConfig`, console redirection)
 *      BEFORE anything else, so transitive imports from `~/server/utils/*`
 *      can resolve their globals.
 *   2. Resolve auth mode (webhook / oauth-active / oauth-onboarding) and
 *      wire the dispatcher override (#207). The full tool catalogue is
 *      always registered — onboarding-mode tool calls surface a
 *      friendly "run paste-code first" error rather than a 500.
 *   3. Lazy-import the tool registry — keeps the side-effecting shim import
 *      ordered ahead of any module that depends on it.
 *   4. Spin up `McpServer` + `StdioServerTransport` and register every tool
 *      via the toolkit's shared `registerToolFromDefinition` helper. This is
 *      the same helper Nuxt's HTTP transport uses, so behaviour (cache,
 *      error normalisation, metadata) is identical to the deployed server.
 */
import './nuxt-shims.js'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { redactString } from '~/server/utils/logger-redactor'
import { resolveAuthMode } from './auth-mode.js'
import { registerToolFromDefinition } from './register.js'
import { buildOnboardingUrl, buildPasteCodeTool } from './tools-oauth.js'

const { tools } = await import('./tools.js')

async function main() {
  const cfg = useRuntimeConfig()
  const mode = resolveAuthMode({
    webhookUrl: cfg.bitrix24WebhookUrl,
    oauthClientId: cfg.dxtOauthClientId,
    oauthClientSecret: cfg.dxtOauthClientSecret,
    portalHost: cfg.dxtPortalHost,
    dataDirOverride: cfg.dxtDataDir || undefined,
  })

  if (!mode) {
    process.stderr.write(
      'No Bitrix24 credentials configured.\n'
        + '  • For webhook mode: fill the `Bitrix24 webhook URL` field in Claude Desktop (Settings → Extensions → bx24-template-mcp). For a local dry-run, export `NUXT_BITRIX24_WEBHOOK_URL`.\n'
        + '  • For OAuth mode: fill ALL THREE Claude Desktop fields — `Bitrix24 portal host`, `Bitrix24 OAuth Client ID`, `Bitrix24 OAuth Client Secret`. The Client ID + Secret come from a Bitrix24 Marketplace application of type "without redirect_uri" (register in your partner cabinet). The bundle stores Secret in the OS keychain via Claude Desktop\'s `sensitive: true` flag. For a local dry-run, export the matching `NUXT_BITRIX24_DXT_*` env vars instead.\n',
    )
    process.exit(1)
  }

  if (mode === 'oauth-onboarding') {
    // Print the consent URL to stderr so it shows up in Claude Desktop's
    // extension log panel before the first tool call. The agent will
    // also see this guidance via the paste-code tool's description, but
    // the human operator needs the URL plainly visible.
    const url = buildOnboardingUrl({ portalHost: cfg.dxtPortalHost, clientId: cfg.dxtOauthClientId })
    process.stderr.write(
      `\nBitrix24 OAuth onboarding required.\n`
        + `  1. Open: ${url}\n`
        + `  2. Sign in to your Bitrix24 portal and grant consent.\n`
        + `  3. Copy the short code displayed on the consent page.\n`
        + `  4. In Claude, ask the assistant to call \`bx24mcp_oauth_paste_code\` with that code.\n\n`,
    )
  }

  const server = new McpServer({
    name: 'bx24-template-mcp',
    version: '0.1.0',
  })

  for (const tool of tools) {
    registerToolFromDefinition(server, tool as Parameters<typeof registerToolFromDefinition>[1])
  }

  // Stdio-only meta tool — registered when OAuth is possible at all
  // (active OR onboarding). In active mode it lets the operator
  // re-onboard after a revocation without restarting Claude Desktop.
  if (mode === 'oauth-active' || mode === 'oauth-onboarding') {
    const pasteCode = buildPasteCodeTool({
      clientId: cfg.dxtOauthClientId,
      clientSecret: cfg.dxtOauthClientSecret,
      portalHost: cfg.dxtPortalHost,
      dataDirOverride: cfg.dxtDataDir || undefined,
    })
    registerToolFromDefinition(server, pasteCode as Parameters<typeof registerToolFromDefinition>[1])
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  // Defence-in-depth: pass the raw stack/message through `redactString` before
  // it reaches Claude Desktop's extension log panel. The `useBitrix24()`
  // wrapper already scrubs webhook-parse errors (see sdk-logger-leak test),
  // but any future SDK throw with a URL in `.message`/`.stack` bypasses that
  // path and would land here unredacted.
  const raw = err instanceof Error ? err.stack ?? err.message : String(err)
  process.stderr.write(`Fatal MCP stdio error: ${redactString(raw)}\n`)
  process.exit(1)
})
