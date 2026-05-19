/**
 * Nuxt-runtime shims for the stdio MCP entrypoint.
 *
 * The same tool files in `server/mcp/tools/` are reused unchanged. Those
 * files call `useRuntimeConfig()` (Nuxt global) transitively via
 * `~/server/utils/bitrix24.ts` and `~/server/utils/github-feedback.ts`. In
 * the stdio context there is no Nuxt runtime — we synthesise the same shape
 * from `process.env` and expose it on `globalThis` before any tool module
 * loads.
 *
 * Stdout safety: MCP stdio transport reserves `process.stdout` for JSON-RPC
 * frames. The Bitrix24 SDK's `ConsoleHandler` writes via `console.log` /
 * `console.info`, which would corrupt the protocol stream. We re-bind those
 * to stderr here, before any tool import resolves and pulls the logger in.
 *
 * Zod init: zod 4 declares `"sideEffects": false`, so esbuild lazy-inits
 * its schema classes via `__esm({})` wrappers. The MCP SDK's `types.js`
 * evaluates `z.custom(...)` at module top level — if SDK init fires before
 * any zod init wrapper has run, `ZodCustom` is still `undefined` and
 * `_custom` throws `Class<N> is not a constructor`. Touching `z.string()`
 * below schedules `init_schemas2()` before any consumer top-level code
 * runs (this module is imported first by `server.ts`).
 */
import { z } from 'zod'

interface RuntimeConfig {
  bitrix24WebhookUrl: string
  mcpAuthToken: string
  githubFeedbackToken: string
  githubFeedbackRepo: string
  logLevel: string
}

const runtimeConfig: RuntimeConfig = {
  bitrix24WebhookUrl: process.env.BITRIX24_WEBHOOK_URL ?? '',
  // Bearer auth is not used in stdio — the host (Claude Desktop) provides
  // transport-level trust. Keep the shape so middleware imports type-check.
  mcpAuthToken: '',
  githubFeedbackToken: process.env.GITHUB_FEEDBACK_TOKEN ?? '',
  githubFeedbackRepo: process.env.GITHUB_FEEDBACK_REPO ?? 'bitrix24/templates-mcp',
  logLevel: process.env.LOG_LEVEL ?? 'info',
}

;(globalThis as unknown as { useRuntimeConfig: () => RuntimeConfig }).useRuntimeConfig = () =>
  runtimeConfig

// Re-bind stdout-writing console methods (`log`/`info`/`debug`) to stderr so
// the SDK logger or any stray `console.log` cannot corrupt the JSON-RPC frame
// stream. `console.warn` already writes to stderr in Node — re-binding it
// here is a uniformity / defence-in-depth measure: third-party `console.warn`
// shims in transitive deps may route to stdout, and the cost of pinning the
// target is one line.
/* eslint-disable no-console */
console.log = console.error.bind(console)
console.info = console.error.bind(console)
console.debug = console.error.bind(console)
console.warn = console.error.bind(console)
/* eslint-enable no-console */

// Force zod init — see header comment.
void z.string()
