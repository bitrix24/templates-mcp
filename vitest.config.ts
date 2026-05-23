import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * `envPrefix` is intentionally narrow — narrower than the default
 * `['NUXT_', ...]` you might reach for. Only three prefixes are autoloaded
 * from `.env` into `process.env` when Vitest (and the evalite CLI, which
 * reuses this config) runs:
 *
 * - `VITE_*` — the framework default; we keep it for parity.
 * - `NUXT_BITRIX24_TEST_*` — used by the integration suite via
 *   `NUXT_BITRIX24_TEST_WEBHOOK_URL` (`tests/integration/`).
 * - `DEEPSEEK_*` — used by the evals CLI via `DEEPSEEK_API_KEY` and
 *   `DEEPSEEK_BASE_URL` (`tests/evals/`).
 *
 * What this deliberately does NOT load: `NUXT_BITRIX24_WEBHOOK_URL`,
 * `NUXT_MCP_AUTH_TOKEN`, `NUXT_GITHUB_FEEDBACK_TOKEN`, `NUXT_AUDIT_DIR`,
 * `NUXT_LOG_LEVEL` and any other `NUXT_*` a developer keeps in `.env` for
 * `pnpm dev`. A unit test that writes to those names is now asserting
 * against a known-empty `process.env`, which is the whole point of
 * #144 — it removes the per-file `Reflect.deleteProperty` boilerplate
 * PR #142 had to add when the prefix was a permissive `NUXT_*`.
 *
 * When adding a NEW env var that a test should read from `.env`:
 *   - If it is part of the integration test setup, name it
 *     `NUXT_BITRIX24_TEST_<thing>` so it falls under this prefix.
 *   - If it is for evals, name it `DEEPSEEK_<thing>`.
 *   - Anything else means you almost certainly want it set in the shell
 *     for that one test invocation, not committed to `.env`.
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
