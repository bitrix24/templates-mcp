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
