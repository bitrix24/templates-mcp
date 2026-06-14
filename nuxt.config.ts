import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8')) as { version: string }

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  modules: ['@nuxtjs/mcp-toolkit', '@bitrix24/b24jssdk-nuxt', '@bitrix24/b24ui-nuxt', '@nuxt/eslint'],

  css: ['~/assets/css/main.css'],

  mcp: {
    route: '/mcp',
    name: 'bx24-template-mcp',
    version,
  },

  runtimeConfig: {
    bitrix24WebhookUrl: '',
    mcpAuthToken: '',
    githubFeedbackToken: '',
    githubFeedbackRepo: 'bitrix24/templates-mcp',
    // Documents the NUXT_LOG_LEVEL → logLevel binding for tooling/discoverability.
    // NOT the runtime source of truth: `server/utils/logger.ts` reads
    // `process.env.NUXT_LOG_LEVEL ?? LOG_LEVEL` directly (it must resolve before
    // the Nitro app context exists), so setting this field programmatically does
    // not change the log level — set the env var instead.
    logLevel: 'info',
    // OAuth 2.0 / multi-tenant scaffolding (`docs/OAUTH-DESIGN.md`). All
    // empty/false by default — webhook flow stays the canonical path until
    // an operator explicitly opts in. The full surface (token store, install
    // / callback routes, refresh logic) lands in PR-2b/c; the flag and
    // dispatcher are wired now so existing tools migrate via a mechanical
    // `useBitrix24()` → `useBitrix24Tenant()` swap later.
    bitrix24OauthEnabled: false,
    bitrix24OauthClientId: '',
    bitrix24OauthClientSecret: '',
    bitrix24OauthRedirectUrl: '',
    bitrix24OauthScope: 'user,task',
    bitrix24OauthDbDir: '/data',
    // PR-2c: admin token guarding `/api/oauth/_health` (operator-tier
    // observability endpoint per OAUTH-DESIGN.md §11). When empty, the
    // route fails closed unless the request comes from localhost
    // (e.g. an nginx `proxy_pass` inside the same network namespace).
    // NEVER fall back to `bitrix24OauthEnabled` or `mcpAuthToken` here —
    // the privilege levels differ (agent token vs operator token).
    bitrix24OauthAdminToken: '',
    // Operator-UX brand-styled landing (#233). Both default empty/false
    // → identical to v0.2.0 strict-CSP unstyled output. When
    // `bitrix24OauthBrandStyles=true` the install + callback HTML pages
    // ship a minimal inline stylesheet under a per-response CSP nonce
    // (`style-src 'nonce-<base64>'`) — the strict baseline (`default-src
    // 'none'; frame-ancestors 'none'`) is preserved for everything else.
    // `bitrix24OauthAppDisplayName` lets fork operators rebrand the
    // landing heading from "Connect your Bitrix24 portal" to e.g.
    // "Connect your Acme Bitrix24" without forking the template.
    bitrix24OauthBrandStyles: false,
    bitrix24OauthAppDisplayName: '',
    // DXT-only OAuth surface (#207, OOB code-paste). Always empty on the
    // HTTP server — the stdio shim populates them from build-time defines
    // and `user_config`. Declared here so the `runtimeConfig` type
    // contract matches the shim's `RuntimeConfig` interface and shared
    // server utils that destructure these names type-check uniformly.
    dxtOauthClientId: '',
    dxtOauthClientSecret: '',
    dxtPortalHost: '',
    dxtDataDir: '',
  },

  nitro: {
    preset: 'node-server',
  },

  vite: {
    // Pre-bundle the b24icons-vue subpath entry points the landing imports
    // from. Without this, Vite discovers them lazily on first request and
    // triggers a dep re-optimization + full page reload in dev ("Re-optimizing
    // dependencies because vite config has changed"). Listing them here makes
    // the optimizer pick them up on startup instead.
    optimizeDeps: {
      include: [
        '@bitrix24/b24icons-vue/editor',
        '@bitrix24/b24icons-vue/social',
        '@bitrix24/b24icons-vue/solid',
      ],
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
    tsConfig: {
      compilerOptions: {
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        forceConsistentCasingInFileNames: true,
      },
    },
  },
})
