// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  modules: ['@nuxtjs/mcp-toolkit', '@bitrix24/b24jssdk-nuxt', '@bitrix24/b24ui-nuxt', '@nuxt/eslint'],

  css: ['~/assets/css/main.css'],

  mcp: {
    route: '/mcp',
    name: 'bx24-template-mcp',
    version: '0.1.0-alpha.1',
  },

  runtimeConfig: {
    bitrix24WebhookUrl: '',
    mcpAuthToken: '',
    githubFeedbackToken: '',
    githubFeedbackRepo: 'bitrix24/templates-mcp',
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
