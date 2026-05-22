#!/usr/bin/env node
/**
 * Stdio MCP entrypoint — what Claude Desktop launches when the user
 * installs the `.dxt` bundle.
 *
 * Pipeline:
 *   1. Install Nuxt-runtime shims (`useRuntimeConfig`, console redirection)
 *      BEFORE anything else, so transitive imports from `~/server/utils/*`
 *      can resolve their globals.
 *   2. Lazy-import the tool registry — keeps the side-effecting shim import
 *      ordered ahead of any module that depends on it.
 *   3. Spin up `McpServer` + `StdioServerTransport` and register every tool
 *      via the toolkit's shared `registerToolFromDefinition` helper. This is
 *      the same helper Nuxt's HTTP transport uses, so behaviour (cache,
 *      error normalisation, metadata) is identical to the deployed server.
 */
import './nuxt-shims.js'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { redactString } from '~/server/utils/logger-redactor'
import { registerToolFromDefinition } from './register.js'

const { tools } = await import('./tools.js')

async function main() {
  if (!process.env.NUXT_BITRIX24_WEBHOOK_URL && !process.env.BITRIX24_WEBHOOK_URL) {
    process.stderr.write(
      'NUXT_BITRIX24_WEBHOOK_URL is not set. Claude Desktop should pass it through '
        + 'the DXT user_config; if you are running the bundle directly, set it '
        + 'in the environment first.\n',
    )
    process.exit(1)
  }

  const server = new McpServer({
    name: 'bx24-template-mcp',
    version: '0.1.0',
  })

  for (const tool of tools) {
    // The toolkit's `McpToolDefinition` is generic over the input/output Zod
    // shapes; our minimal `ToolDefinition` is the structural projection the
    // stdio register helper actually consumes. The cast widens away the
    // unused generics — Zod has already validated wire input upstream of the
    // handler boundary.
    registerToolFromDefinition(server, tool as Parameters<typeof registerToolFromDefinition>[1])
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
