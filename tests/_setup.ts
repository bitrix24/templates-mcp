/**
 * Vitest setup — applied to every test file via `vitest.config.ts`'s
 * `test.setupFiles`. Provides safe-default stubs for Nuxt auto-imports
 * that a unit test can't materialise (no Nuxt runtime in `pnpm test`).
 *
 * The dispatcher in `server/utils/bitrix24-tenant.ts` calls
 * `useRuntimeConfig()` to read the OAuth flag, which is a Nuxt auto-import
 * (a real global at runtime, undefined under Vitest). After PR-2d swaps
 * every tool to the dispatcher, the global must exist or every tool test
 * blows up with `ReferenceError: useRuntimeConfig is not defined` long
 * before the test asserts anything.
 *
 * Default returned by the stub: `{ bitrix24OauthEnabled: false }` — webhook
 * fallback path, same value that keeps every pre-PR-2d tool test passing
 * unchanged.
 *
 * ## Overriding the default in a single test file
 *
 * Tests that need a different runtime config (`token-store.test.ts`,
 * `oauth-schema.test.ts`, `bitrix24-tenant.test.ts`, `mcp-auth.test.ts`)
 * override per-file via `vi.stubGlobal('useRuntimeConfig', …)`. **The
 * override MUST be at module level** (top of the test file, outside any
 * `describe` / `beforeEach` / `it`) — Vitest re-applies `setupFiles`-level
 * stubs between test files, and a module-level per-file stub wins because
 * it runs after the setup file but before any test body. A stub inside
 * `describe` body works only by coincidence of evaluation order (collection
 * phase) and may stop working if the test re-imports the module under test
 * mid-suite. If the test needs to flip the config between `it`s, prefer
 * mutating a shared object (see `bitrix24-tenant.test.ts`'s `runtimeConfig`
 * pattern) instead of repeated `vi.stubGlobal` calls.
 *
 * ## Why `defineNitroPlugin` is global, not per-file
 *
 * Currently only one test (`oauth-schema.test.ts`) imports a Nitro plugin
 * (`server/plugins/oauth-schema.ts`). The stub *could* live there alone.
 * It's hoisted here because PR-2d's tool swap makes the dispatcher import
 * graph wider — any future test that transitively pulls in a Nitro plugin
 * (e.g. via `useBitrix24Tenant` → middleware → plugin chain) gets the stub
 * for free, instead of failing on a module-load `ReferenceError` with a
 * stack trace that doesn't mention the plugin. The cost is one
 * three-character identity function; the benefit is no
 * mystery-ReferenceError when PR-2c adds the next plugin. The per-file
 * stub in `oauth-schema.test.ts` is deliberately kept as a redundant
 * pin — it documents the dependency at the use site, even though the
 * global setup would cover it.
 */
import { vi } from 'vitest'

vi.stubGlobal('useRuntimeConfig', () => ({ bitrix24OauthEnabled: false }))
vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)
