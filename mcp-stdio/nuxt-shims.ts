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
  // The HTTP-OAuth keys remain declared (issue #222) so server utils that
  // destructure `bitrix24Oauth*` type-check against the shim. In stdio they
  // are always the disabled-shape — DXT's OAuth path uses the dedicated
  // `dxtOauth*` keys below, NOT this set, because the HTTP install/callback
  // flow doesn't apply.
  bitrix24OauthEnabled: boolean
  bitrix24OauthClientId: string
  bitrix24OauthClientSecret: string
  bitrix24OauthRedirectUrl: string
  bitrix24OauthScope: string
  bitrix24OauthDbDir: string
  bitrix24OauthAdminToken: string
  // Operator-UX brand-styled landing (#233) — HTTP-only, hard-coded
  // disabled in stdio (no /install or /callback HTML to style).
  bitrix24OauthBrandStyles: boolean
  bitrix24OauthAppDisplayName: string
  // DXT-specific OAuth surface (#207, OOB code-paste). These are read by
  // stdio-only modules (`mcp-stdio/oauth-*.ts`) and are never used by HTTP-
  // server code. `dxtOauthClientId` / `_ClientSecret` are baked at build
  // time via esbuild `define` — empty string here is the "OAuth disabled"
  // signal (webhook-only build, or a fork that hasn't supplied secrets).
  // `dxtPortalHost` is operator-supplied via `user_config` at install time.
  // `dxtDataDir` overrides the OS user-data-dir for tests.
  dxtOauthClientId: string
  dxtOauthClientSecret: string
  dxtPortalHost: string
  dxtDataDir: string
}

// Build-time defines (see `mcp-stdio/build.mjs`). Forks that build a custom
// `.dxt` with their own Marketplace credentials inject these via:
//   BITRIX24_DXT_OAUTH_CLIENT_ID=… BITRIX24_DXT_OAUTH_CLIENT_SECRET=… pnpm build:dxt
// The upstream CI workflow pulls them from repo secrets. If unset, the
// strings are baked as `''` and the OAuth path stays disabled at runtime —
// webhook mode is the only viable mode in that build.
declare const __DXT_OAUTH_CLIENT_ID__: string | undefined
declare const __DXT_OAUTH_CLIENT_SECRET__: string | undefined

// Canonical env names are `NUXT_`-prefixed — identical to what the Nuxt HTTP
// server consumes (Nuxt maps `NUXT_<KEY>` onto `runtimeConfig.<key>`). The DXT
// manifest now injects these same names, so one variable name works in both
// deployment modes. The un-prefixed forms are kept as a back-compat fallback
// for bundles built before the unification and for the README dry-run.
const runtimeConfig: RuntimeConfig = {
  bitrix24WebhookUrl:
    process.env.NUXT_BITRIX24_WEBHOOK_URL ?? process.env.BITRIX24_WEBHOOK_URL ?? '',
  // Bearer auth is not used in stdio — the host (Claude Desktop) provides
  // transport-level trust. Keep the shape so middleware imports type-check.
  mcpAuthToken: '',
  githubFeedbackToken:
    process.env.NUXT_GITHUB_FEEDBACK_TOKEN ?? process.env.GITHUB_FEEDBACK_TOKEN ?? '',
  githubFeedbackRepo:
    process.env.NUXT_GITHUB_FEEDBACK_REPO
    ?? process.env.GITHUB_FEEDBACK_REPO
    ?? 'bitrix24/templates-mcp',
  logLevel: process.env.NUXT_LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info',
  // HTTP-OAuth always OFF in stdio. The install/callback/Bearer surface
  // doesn't exist in this transport.
  bitrix24OauthEnabled: false,
  bitrix24OauthClientId: '',
  bitrix24OauthClientSecret: '',
  bitrix24OauthRedirectUrl: '',
  bitrix24OauthScope: '',
  bitrix24OauthDbDir: '',
  bitrix24OauthAdminToken: '',
  // Operator-UX brand-styled landing — HTTP-only feature.
  bitrix24OauthBrandStyles: false,
  bitrix24OauthAppDisplayName: '',
  // DXT-OAuth surface. `__DXT_*__` is replaced literally by esbuild at build
  // time. The `typeof` guard keeps the shim importable in `vitest`/`pnpm dev`
  // (where esbuild's `define` hasn't run and the identifier is undefined) —
  // tests get the disabled shape, which matches a webhook-only build.
  dxtOauthClientId: typeof __DXT_OAUTH_CLIENT_ID__ === 'string' ? __DXT_OAUTH_CLIENT_ID__ : '',
  dxtOauthClientSecret: typeof __DXT_OAUTH_CLIENT_SECRET__ === 'string' ? __DXT_OAUTH_CLIENT_SECRET__ : '',
  dxtPortalHost:
    process.env.NUXT_BITRIX24_DXT_PORTAL_HOST ?? process.env.BITRIX24_DXT_PORTAL_HOST ?? '',
  dxtDataDir: process.env.NUXT_BITRIX24_DXT_DATA_DIR ?? process.env.BITRIX24_DXT_DATA_DIR ?? '',
}

;(globalThis as unknown as { useRuntimeConfig: () => RuntimeConfig }).useRuntimeConfig = () =>
  runtimeConfig

// Stdio-mode marker (#207 /review O1). `server/utils/bitrix24-tenant.ts`
// auto-exports `_setStdioClientOverride` and Nitro's auto-imports glob
// surfaces it as a top-level identifier in every h3 handler — making
// it accidentally callable on the HTTP server. The setter guards on
// this flag and refuses the override when it's absent (i.e. when the
// dispatcher is being called from a real HTTP context that never
// imported the stdio shim).
;(globalThis as unknown as { __DXT_STDIO_MODE__: boolean }).__DXT_STDIO_MODE__ = true

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
