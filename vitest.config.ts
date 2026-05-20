import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // Vite only loads variables from `.env` whose names match one of these
  // prefixes; the default is `VITE_` alone, which silently drops every
  // `NUXT_*` / `DEEPSEEK_*` value. Without this, the integration suite
  // (NUXT_BITRIX24_TEST_WEBHOOK_URL) and the eval suite (DEEPSEEK_API_KEY)
  // never see their `.env` config locally and skip themselves — even though
  // CI passes the same values directly via the workflow `env:` block.
  // evalite reuses this config too, so this single line fixes `test`,
  // `test:integration`, and `test:evals`. Test-only: the Nuxt build reads
  // nuxt.config.ts, so widening the prefix here cannot leak vars into the
  // client bundle.
  envPrefix: ['VITE_', 'NUXT_', 'DEEPSEEK_'],
  test: {
    globals: true,
    environment: 'node',
    // Unit tests live in *.test.ts. Evals live in *.eval.ts and are picked
    // up by the `evalite` CLI separately (see evalite.config.ts).
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['server/**/*.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
      },
    },
  },
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('.', import.meta.url)),
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
})
