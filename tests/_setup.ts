/**
 * Vitest setup — applied to every test file via `vitest.config.ts`'s
 * `test.setupFiles`. Provides safe-default stubs for Nuxt auto-imports that
 * a unit test can't materialise (no Nuxt runtime in `pnpm test`).
 *
 * The dispatcher in `server/utils/bitrix24-tenant.ts` calls
 * `useRuntimeConfig()` to read the OAuth flag, which is a Nuxt auto-import
 * (a real global at runtime, undefined under Vitest). After PR-2d swaps
 * every tool to the dispatcher, the global must exist or every tool test
 * blows up with `ReferenceError: useRuntimeConfig is not defined` long
 * before the test asserts anything.
 *
 * Default returned by the stub: `bitrix24OauthEnabled = false`, i.e.
 * webhook fallback path — same shape PR-2a's dispatcher expects, and the
 * value that keeps every existing tool test passing unchanged. Tests that
 * need a different value (`token-store.test.ts`, `oauth-schema.test.ts`,
 * `bitrix24-tenant.test.ts`) override per-file via their own
 * `vi.stubGlobal('useRuntimeConfig', …)` — Vitest's per-file stubs win
 * over the global setup.
 *
 * `defineNitroPlugin` is added for the same reason: Nitro plugins are
 * standalone modules that any test importing them transitively will fail
 * to load without the global. The stub is the identity function so the
 * plugin's exported handler comes through unchanged.
 */
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ bitrix24OauthEnabled: false }))
vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)
