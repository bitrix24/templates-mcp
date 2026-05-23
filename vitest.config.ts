import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * `envPrefix` is intentionally narrow. Only three prefixes are autoloaded
 * from `.env` into `process.env` when Vitest (and the evalite CLI, which
 * reuses this config) runs:
 *
 * - `VITE_*` — required by Vite's own plugin ecosystem; kept for completeness.
 * - `NUXT_BITRIX24_TEST_*` — integration suite (`NUXT_BITRIX24_TEST_WEBHOOK_URL`).
 * - `DEEPSEEK_*` — evals CLI (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`).
 *
 * Production-shaped names a developer keeps in `.env` for `pnpm dev`
 * (`NUXT_BITRIX24_WEBHOOK_URL`, `NUXT_MCP_AUTH_TOKEN`, `NUXT_GITHUB_FEEDBACK_TOKEN`,
 * `NUXT_LOG_LEVEL`, `NUXT_AUDIT_DIR`) are deliberately NOT loaded — see #144.
 * Any new env var a test reads from `.env` MUST use one of the three prefixes
 * above; new contributor-facing documentation lives in `CONTRIBUTING.md`.
 * A CI step (`.github/workflows/ci.yml` "Pin envPrefix") fails the build if
 * this line widens back to a permissive `NUXT_*`.
 */

const repoRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  envPrefix: ['VITE_', 'NUXT_BITRIX24_TEST_', 'DEEPSEEK_'],
  resolve: {
    alias: {
      '~': repoRoot,
      '@': repoRoot,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Unit + integration tests live in *.test.ts. Evals live in *.eval.ts
    // and are picked up by the `evalite` CLI separately (see evalite.config.ts).
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
})
