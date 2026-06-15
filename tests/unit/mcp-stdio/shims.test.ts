import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Unit tests for `mcp-stdio/nuxt-shims.ts` — the runtime-config projection
 * and stdout/stderr re-binding installed before any tool import resolves.
 *
 * Why this exists: the projection maps `process.env.*` → `runtimeConfig.*`
 * by hand (five fields). A typo on either side — `process.env.GITHUB_FEEDBACK_TOKEN`
 * vs `GITHUB_TOKEN`, or `runtimeConfig.bitrix24WebhookUrl` vs
 * `bitrixWebhookUrl` — would silently mis-wire the DXT bundle without any
 * CI signal until an operator hits "tool returned empty result" at runtime.
 * This test pins the contract so the redirect can't drift.
 *
 * The shim has module-level side effects (writes `globalThis.useRuntimeConfig`
 * and re-binds `console.log/info/debug/warn`), so each case starts from a
 * fresh module via `vi.resetModules()`.
 */

interface ShimRuntimeConfig {
  bitrix24WebhookUrl: string
  mcpAuthToken: string
  githubFeedbackToken: string
  githubFeedbackRepo: string
  logLevel: string
  bitrix24OauthEnabled: boolean
  bitrix24OauthClientId: string
  bitrix24OauthClientSecret: string
  bitrix24OauthRedirectUrl: string
  bitrix24OauthScope: string
  bitrix24OauthDbDir: string
  bitrix24OauthAdminToken: string
  bitrix24OauthBrandStyles: boolean
  bitrix24OauthAppDisplayName: string
  dxtOauthClientId: string
  dxtOauthClientSecret: string
  dxtPortalHost: string
  dxtDataDir: string
}

const ENV_VARS = [
  'NUXT_BITRIX24_WEBHOOK_URL',
  'NUXT_MCP_AUTH_TOKEN',
  'NUXT_GITHUB_FEEDBACK_TOKEN',
  'NUXT_GITHUB_FEEDBACK_REPO',
  'NUXT_LOG_LEVEL',
  'NUXT_BITRIX24_DXT_PORTAL_HOST',
  'NUXT_BITRIX24_DXT_OAUTH_CLIENT_ID',
  'NUXT_BITRIX24_DXT_OAUTH_CLIENT_SECRET',
  'NUXT_BITRIX24_DXT_DATA_DIR',
  'BITRIX24_WEBHOOK_URL',
  'MCP_AUTH_TOKEN',
  'GITHUB_FEEDBACK_TOKEN',
  'GITHUB_FEEDBACK_REPO',
  'LOG_LEVEL',
  'BITRIX24_DXT_PORTAL_HOST',
  'BITRIX24_DXT_OAUTH_CLIENT_ID',
  'BITRIX24_DXT_OAUTH_CLIENT_SECRET',
  'BITRIX24_DXT_DATA_DIR',
] as const

describe('mcp-stdio/nuxt-shims runtimeConfig projection', () => {
  const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string | undefined>> = {}
  // Snapshot the original console methods so afterEach can restore them after
  // the shim re-binds log/info/debug/warn to console.error. `error` itself is
  // not re-bound by the shim, so it is not snapshotted here.
  /* eslint-disable no-console -- reading method references for restore */
  const savedConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
  }
  /* eslint-enable no-console */

  beforeEach(() => {
    // Snapshot + wipe each supported env name. Snapshotting alone would be
    // sufficient against `.env` autoload (which `vitest.config.ts` already
    // closes via the narrowed `envPrefix` — see #144), but a developer who
    // runs `export NUXT_BITRIX24_WEBHOOK_URL=… && pnpm test:unit` still puts
    // that value in `process.env` directly, bypassing Vite. The shim reads
    // `NUXT_*` first, so without this wipe the shell-exported value would
    // project into the assertion diff on a failure and leak the secret
    // into local logs. The set ENV_VARS only covers the names the shim
    // reads or that the cases below mutate; new env reads in this test
    // file must be added to that list to stay covered.
    for (const key of ENV_VARS) {
      savedEnv[key] = process.env[key]
      Reflect.deleteProperty(process.env, key)
    }
    // The shim is a singleton — it mutates `globalThis.useRuntimeConfig` and
    // `console.*` on first import. Reset module cache so each test sees a
    // fresh module evaluation under the env values it set up.
    vi.resetModules()
  })

  afterEach(() => {
    for (const key of ENV_VARS) {
      if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = savedEnv[key]
    }
    // Restore the original console methods that the shim re-bound.
    Object.assign(console, savedConsole)
  })

  it('projects every supported env var into the matching runtimeConfig field', async () => {
    process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.ru/rest/1/abc/'
    process.env.GITHUB_FEEDBACK_TOKEN = 'ghp_test123'
    process.env.GITHUB_FEEDBACK_REPO = 'acme/forked'
    process.env.LOG_LEVEL = 'debug'
    await import('../../../mcp-stdio/nuxt-shims')
    const cfg = (globalThis as unknown as { useRuntimeConfig: () => ShimRuntimeConfig }).useRuntimeConfig()
    expect(cfg).toEqual({
      bitrix24WebhookUrl: 'https://example.bitrix24.ru/rest/1/abc/',
      mcpAuthToken: '',
      githubFeedbackToken: 'ghp_test123',
      githubFeedbackRepo: 'acme/forked',
      logLevel: 'debug',
      // OAuth is HTTP-server-only — the shim hard-codes the disabled shape
      // (issue #222) so server utils that destructure `bitrix24Oauth*`
      // type-check and read falsy in the stdio bundle. Pinned here so a drift
      // from `nuxt.config.ts` is caught.
      bitrix24OauthEnabled: false,
      bitrix24OauthClientId: '',
      bitrix24OauthClientSecret: '',
      bitrix24OauthRedirectUrl: '',
      bitrix24OauthScope: '',
      bitrix24OauthDbDir: '',
      bitrix24OauthAdminToken: '',
      // Operator-UX brand styling (#233) — HTTP-only, always disabled in stdio.
      bitrix24OauthBrandStyles: false,
      bitrix24OauthAppDisplayName: '',
      // DXT-OAuth keys (#207, #247). Defaults when no env vars are set —
      // empty client id is the "OAuth disabled" signal that `auth-mode.ts`
      // resolves to webhook mode at boot. The values now flow from Claude
      // Desktop's `user_config` block via the manifest's env mapping
      // (no more build-time baking); the projection itself is the same
      // `process.env.NUXT_BITRIX24_DXT_*` → `runtimeConfig.dxt*` shape
      // tested by the dedicated case below. Pinned so a drift in the
      // four-field set is caught.
      dxtOauthClientId: '',
      dxtOauthClientSecret: '',
      dxtPortalHost: '',
      dxtDataDir: '',
    })
  })

  it('projects the canonical `NUXT_`-prefixed env vars (same names as the Nuxt HTTP server)', async () => {
    process.env.NUXT_BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.ru/rest/1/abc/'
    process.env.NUXT_GITHUB_FEEDBACK_TOKEN = 'ghp_test123'
    process.env.NUXT_GITHUB_FEEDBACK_REPO = 'acme/forked'
    process.env.NUXT_LOG_LEVEL = 'debug'
    await import('../../../mcp-stdio/nuxt-shims')
    const cfg = (globalThis as unknown as { useRuntimeConfig: () => ShimRuntimeConfig }).useRuntimeConfig()
    expect(cfg).toEqual({
      bitrix24WebhookUrl: 'https://example.bitrix24.ru/rest/1/abc/',
      mcpAuthToken: '',
      githubFeedbackToken: 'ghp_test123',
      githubFeedbackRepo: 'acme/forked',
      logLevel: 'debug',
      bitrix24OauthEnabled: false,
      bitrix24OauthClientId: '',
      bitrix24OauthClientSecret: '',
      bitrix24OauthRedirectUrl: '',
      bitrix24OauthScope: '',
      bitrix24OauthDbDir: '',
      bitrix24OauthAdminToken: '',
      // Operator-UX brand styling (#233) — HTTP-only, always disabled in stdio.
      bitrix24OauthBrandStyles: false,
      bitrix24OauthAppDisplayName: '',
      // DXT-OAuth keys (#207, #247). Defaults when no env vars are set —
      // empty client id is the "OAuth disabled" signal that `auth-mode.ts`
      // resolves to webhook mode at boot. The values now flow from Claude
      // Desktop's `user_config` block via the manifest's env mapping
      // (no more build-time baking); the projection itself is the same
      // `process.env.NUXT_BITRIX24_DXT_*` → `runtimeConfig.dxt*` shape
      // tested by the dedicated case below. Pinned so a drift in the
      // four-field set is caught.
      dxtOauthClientId: '',
      dxtOauthClientSecret: '',
      dxtPortalHost: '',
      dxtDataDir: '',
    })
  })

  it('prefers the `NUXT_`-prefixed name over the un-prefixed back-compat fallback', async () => {
    // Pin the precedence for every paired field so a future reorder of the
    // `?? `-chain in nuxt-shims.ts cannot regress one of them silently.
    process.env.NUXT_BITRIX24_WEBHOOK_URL = 'https://canonical.bitrix24.ru/rest/1/abc/'
    process.env.BITRIX24_WEBHOOK_URL = 'https://legacy.bitrix24.ru/rest/9/zzz/'
    process.env.NUXT_GITHUB_FEEDBACK_TOKEN = 'ghp_canonical'
    process.env.GITHUB_FEEDBACK_TOKEN = 'ghp_legacy'
    process.env.NUXT_GITHUB_FEEDBACK_REPO = 'acme/canonical'
    process.env.GITHUB_FEEDBACK_REPO = 'acme/legacy'
    process.env.NUXT_LOG_LEVEL = 'debug'
    process.env.LOG_LEVEL = 'trace'
    await import('../../../mcp-stdio/nuxt-shims')
    const cfg = (globalThis as unknown as { useRuntimeConfig: () => ShimRuntimeConfig }).useRuntimeConfig()
    expect(cfg.bitrix24WebhookUrl).toBe('https://canonical.bitrix24.ru/rest/1/abc/')
    expect(cfg.githubFeedbackToken).toBe('ghp_canonical')
    expect(cfg.githubFeedbackRepo).toBe('acme/canonical')
    expect(cfg.logLevel).toBe('debug')
  })

  it('manifest pins the sensitive flag per OAuth field (CLIENT_SECRET → keychain, CLIENT_ID → public — #247)', async () => {
    // Closes the silent-swap regression: if a future PR flipped
    // `sensitive: true` on the wrong field (e.g. marking CLIENT_ID as
    // sensitive while leaving CLIENT_SECRET as plain text), the bundle's
    // build-time `validateManifest()` would pass — the MCPB schema only
    // checks shape, not business semantics. Pin the per-field invariant
    // here so the regression goes red instead of silently shipping a
    // CLIENT_SECRET into a plain-text config file.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, '../../../mcp-stdio/manifest.json'), 'utf8'),
    ) as {
      user_config: Record<string, { sensitive?: boolean }>
    }
    expect(manifest.user_config.bitrix24_oauth_client_id?.sensitive ?? false).toBe(false)
    expect(manifest.user_config.bitrix24_oauth_client_secret?.sensitive).toBe(true)
    expect(manifest.user_config.webhook_url?.sensitive).toBe(true)
    expect(manifest.user_config.github_feedback_token?.sensitive).toBe(true)
  })

  it('projects DXT OAuth creds from env vars (manifest user_config → env path, #247)', async () => {
    // Closes the "OAuth creds are now runtime, not baked" rewire. Claude
    // Desktop maps `user_config.bitrix24_oauth_client_id` /
    // `bitrix24_oauth_client_secret` to `NUXT_BITRIX24_DXT_OAUTH_CLIENT_ID`
    // / `_CLIENT_SECRET` env vars (see `mcp-stdio/manifest.json` →
    // `server.mcp_config.env`). This test pins that the shim reads those
    // names and lands them on the matching `dxtOauth*` keys; the rest of
    // the bundle (e.g. `auth-mode.ts`) keys off the empty/non-empty
    // distinction to pick webhook vs OAuth mode.
    process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.ru/rest/1/abc/'
    process.env.NUXT_BITRIX24_DXT_PORTAL_HOST = 'acme.bitrix24.com'
    process.env.NUXT_BITRIX24_DXT_OAUTH_CLIENT_ID = 'app.cid.from-user-config'
    process.env.NUXT_BITRIX24_DXT_OAUTH_CLIENT_SECRET = 'super-secret-from-keychain'
    await import('../../../mcp-stdio/nuxt-shims')
    const cfg = (globalThis as unknown as { useRuntimeConfig: () => ShimRuntimeConfig }).useRuntimeConfig()
    expect(cfg.dxtPortalHost).toBe('acme.bitrix24.com')
    expect(cfg.dxtOauthClientId).toBe('app.cid.from-user-config')
    expect(cfg.dxtOauthClientSecret).toBe('super-secret-from-keychain')
  })

  it('DXT OAuth creds honour the un-prefixed back-compat fallback (forks running `pnpm build:dxt` locally with shell exports)', async () => {
    // Same `?? `-chain pattern as every other DXT key (#207). A developer
    // who exports `BITRIX24_DXT_OAUTH_CLIENT_ID=…` from their shell before
    // `pnpm dev` or local smoke testing should see those values projected
    // just like the canonical `NUXT_`-prefixed form.
    process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.ru/rest/1/abc/'
    process.env.BITRIX24_DXT_OAUTH_CLIENT_ID = 'app.cid.from-shell'
    process.env.BITRIX24_DXT_OAUTH_CLIENT_SECRET = 'secret-from-shell'
    await import('../../../mcp-stdio/nuxt-shims')
    const cfg = (globalThis as unknown as { useRuntimeConfig: () => ShimRuntimeConfig }).useRuntimeConfig()
    expect(cfg.dxtOauthClientId).toBe('app.cid.from-shell')
    expect(cfg.dxtOauthClientSecret).toBe('secret-from-shell')
  })

  it('NUXT_ prefix wins over the un-prefixed fallback for the DXT OAuth keys (precedence parity with the other paired fields)', async () => {
    process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.ru/rest/1/abc/'
    process.env.NUXT_BITRIX24_DXT_OAUTH_CLIENT_ID = 'app.cid.canonical'
    process.env.BITRIX24_DXT_OAUTH_CLIENT_ID = 'app.cid.legacy'
    process.env.NUXT_BITRIX24_DXT_OAUTH_CLIENT_SECRET = 'secret.canonical'
    process.env.BITRIX24_DXT_OAUTH_CLIENT_SECRET = 'secret.legacy'
    await import('../../../mcp-stdio/nuxt-shims')
    const cfg = (globalThis as unknown as { useRuntimeConfig: () => ShimRuntimeConfig }).useRuntimeConfig()
    expect(cfg.dxtOauthClientId).toBe('app.cid.canonical')
    expect(cfg.dxtOauthClientSecret).toBe('secret.canonical')
  })

  it('defaults `githubFeedbackRepo` to the upstream repo and `logLevel` to info', async () => {
    // beforeEach has already wiped every supported env var; this case sets
    // only the webhook URL so the projection is well-formed, then asserts the
    // two defaults the shim hard-codes when the source env vars are absent.
    process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.ru/rest/1/abc/'
    await import('../../../mcp-stdio/nuxt-shims')
    const cfg = (globalThis as unknown as { useRuntimeConfig: () => ShimRuntimeConfig }).useRuntimeConfig()
    expect(cfg.githubFeedbackRepo).toBe('bitrix24/templates-mcp')
    expect(cfg.logLevel).toBe('info')
  })

  it('keeps `mcpAuthToken` empty — Bearer auth is unused in stdio (Claude Desktop trust)', async () => {
    process.env.NUXT_MCP_AUTH_TOKEN = 'should-not-leak-into-stdio-config'
    process.env.MCP_AUTH_TOKEN = 'should-not-leak-into-stdio-config'
    await import('../../../mcp-stdio/nuxt-shims')
    const cfg = (globalThis as unknown as { useRuntimeConfig: () => ShimRuntimeConfig }).useRuntimeConfig()
    expect(cfg.mcpAuthToken).toBe('')
  })

  it('redirects `console.log` / `info` / `debug` / `warn` through `console.error` (stderr) so JSON-RPC frames on stdout stay clean', async () => {
    process.env.BITRIX24_WEBHOOK_URL = 'https://example.bitrix24.ru/rest/1/abc/'

    // The shim does `console.log = console.error.bind(console)` at module load.
    // If we install a spy on `console.error` BEFORE that import, the bound
    // function the shim creates closes over the spy, so calling
    // `console.log(x)` after the shim transitively invokes the spy.
    // NOTE: this depends on the re-binding happening at top level on import.
    // If the shim is ever refactored to do the re-binding inside a function
    // that runs later, the spy here will silently miss the call and this test
    // will go falsely green — re-anchor the spy then.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await import('../../../mcp-stdio/nuxt-shims')
      /* eslint-disable no-console -- exercising the rebound methods */
      console.log('msg-log')
      console.info('msg-info')
      console.debug('msg-debug')
      console.warn('msg-warn')
      /* eslint-enable no-console */
      const args = errorSpy.mock.calls.map((c) => c.join(' ')).join('|')
      expect(args, 'rebound console methods did not route through console.error').toContain('msg-log')
      expect(args).toContain('msg-info')
      expect(args).toContain('msg-debug')
      expect(args).toContain('msg-warn')
    }
    finally {
      errorSpy.mockRestore()
    }
  })
})
