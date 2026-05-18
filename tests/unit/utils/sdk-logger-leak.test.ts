import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ApiVersion, B24Hook, Logger, type LogRecord, LogLevel, MemoryHandler } from '@bitrix24/b24jssdk'
import { describe, expect, it, vi } from 'vitest'
import { makeRedactingLogger } from '~/server/utils/logger-redactor'

/**
 * Issue #26 / #38 (upstream `bitrix24/b24jssdk` #39) regression guard — the
 * webhook URL contains a secret. If any SDK code path ever logs that URL, the
 * secret leaks to the log sink. We wired the SDK's logger into our structured
 * logger in `server/utils/bitrix24.ts`, so the blast radius is "every log
 * destination we ship to" — file, stdout, aggregator.
 *
 * History — SDK 1.1.1 leaked the webhook URL on every API call via
 * `getLogger().info('post/send', { method: methodFormatted })` in
 * `core/http/abstract-http.mjs`. SDK 1.1.2 fixed it (PR #40) by switching to
 * the bare REST method name. We bumped to 1.1.2 in this PR and kept
 * `makeRedactingLogger` as defence in depth.
 *
 * Two-part CI gate:
 *
 *  1. STATIC SCAN of the installed SDK source tree — enumerates every logger
 *     callsite and asserts none of them include URL-shaped literals or
 *     URL-component variable names in the logged payload. Fails immediately on
 *     a future SDK bump that adds a leaky callsite.
 *
 *  2. RUNTIME SCAN — constructs a real `B24Hook` from a fake webhook URL with
 *     a known sentinel secret, wires a `MemoryHandler`-backed logger, exercises
 *     every code path that runs without network, and asserts the sentinel never
 *     appears in any captured log record or thrown error message. Includes a
 *     "no-redactor" baseline that pins the upstream 1.1.2 fix and a
 *     "with-redactor" defence-in-depth check.
 *
 * The audit writeup is in `docs/SECURITY-AUDIT.md`. The dependency-bump procedure
 * lives there too.
 */

const SDK_ROOT = join(process.cwd(), 'node_modules/@bitrix24/b24jssdk/dist/esm')

/**
 * Recursively walk the SDK source tree and yield every `.mjs` file (skipping
 * sourcemaps and the logger module itself — the logger implementation
 * legitimately formats records including URL-shaped data, and excluding it
 * keeps the scan focused on CALLERS of `_logger.*`, not the logger internals).
 */
function* walkSdkSources(dir: string): Generator<string> {
  // Fail loudly with a clear signal if the SDK source tree isn't where we
  // expect — turns a cryptic ENOENT into "the SDK layout changed, update
  // SDK_ROOT". Happens when bumping `@bitrix24/b24jssdk` to a major version
  // that ships `lib/` instead of `dist/esm/`, or moves to a monorepo path.
  if (!existsSync(dir)) {
    throw new Error(
      `SDK source tree not found at ${dir}. The package layout may have changed in a recent bump. `
        + `Update SDK_ROOT in tests/unit/utils/sdk-logger-leak.test.ts and re-run the audit (docs/SECURITY-AUDIT.md).`,
    )
  }
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    const st = statSync(path)
    if (st.isDirectory()) {
      // Skip the logger implementation directory — handlers and formatters
      // touch URLs as part of their job; the scan is for unintended URL
      // logging by ACTION-layer callers.
      if (entry === 'logger') continue
      yield* walkSdkSources(path)
    } else if (entry.endsWith('.mjs') && !entry.endsWith('.map')) {
      yield path
    }
  }
}

interface LoggerCallsite {
  file: string
  line: number
  snippet: string
}

/**
 * Find every logger callsite in the SDK and capture a multi-line window
 * around each so we can inspect the logged payload.
 *
 * The pattern covers THREE shapes the SDK uses:
 *
 *   1. `this._logger.<level>(...)` — direct field access on the action
 *      layer (8 callsites in call-list / fetch-list as of 1.1.2).
 *   2. `this.getLogger().<level>(...)` — getter access in the HTTP layer
 *      (~15 callsites in `core/http/abstract-http.mjs` plus more across
 *      pull / frame / helper modules).
 *   3. `logger.<level>(...)` — bare reference (used by no current SDK
 *      callsite but kept defensive for future bumps).
 *
 * Missing the getter pattern was the original audit's blind spot — issue
 * #26's first PR shipped a scan that found only the 8 action-layer
 * callsites and declared the HTTP layer clean. The HTTP layer was in fact
 * the primary leak surface in SDK ≤1.1.1; 1.1.2 fixed it (issue
 * bitrix24/b24jssdk#39, PR #40), but the broad scan remains as a
 * regression guard against future bumps re-introducing a URL-shaped
 * payload anywhere in the SDK.
 */
function findLoggerCallsites(): LoggerCallsite[] {
  const callsiteRe = /\b(?:this\.)?(?:_logger|getLogger\s*\(\s*\)|logger)\.(log|debug|info|notice|warning|warn|error|critical|alert|emergency|trace)\s*\(/
  const results: LoggerCallsite[] = []
  for (const file of walkSdkSources(SDK_ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (!callsiteRe.test(line)) continue
      // Capture the call line plus the next 8 lines — enough to cover the
      // full payload object in every SDK 1.1.1 callsite. If a future bump
      // ships callsites with longer payloads, the window can grow without
      // changing the test logic.
      const snippet = lines.slice(i, i + 9).join('\n')
      results.push({ file: file.replace(SDK_ROOT + '/', ''), line: i + 1, snippet })
    }
  }
  return results
}

describe('Issue #26 — SDK logger does not leak webhook URL or secret', () => {
  describe('static scan of installed SDK', () => {
    it('finds the expected order-of-magnitude of SDK files + callsites (sanity vs SDK layout drift)', () => {
      // A bare `> 0` check would pass even if the SDK moved most of its
      // code somewhere we don't scan. We sanity-check against the
      // SDK 1.1.2 baseline: ~100 .mjs files in dist/esm and ~90 logger
      // callsites (8 `_logger.*` in the action layer + ~85 `getLogger().*`
      // across HTTP / pull / frame / helper). If the numbers drop
      // dramatically, the scanner has gone blind to a chunk of the SDK —
      // fail loud so the maintainer updates the matcher.
      let filesScanned = 0
      for (const _ of walkSdkSources(SDK_ROOT)) filesScanned++
      expect(filesScanned, 'SDK file count fell below baseline — layout changed?').toBeGreaterThan(50)

      const callsites = findLoggerCallsites()
      expect(callsites.length, 'logger callsite count fell below baseline — matcher pattern may have gone blind').toBeGreaterThan(30)
    })

    it('every logger callsite logs only safe identifiers (method / requestId / messages) — no URL or secret', () => {
      // Allow-list of identifiers that SDK logger callsites use in their
      // context payloads. If a future SDK bump introduces a new identifier,
      // this test fails — at which point the maintainer must either (a)
      // confirm the new identifier is URL-free and add it here, or (b) refuse
      // the bump.
      //
      // Patterns that would indicate a leak:
      //   - the literal word "url" (case-insensitive) anywhere in the payload
      //   - the literal word "webhook" (case-insensitive)
      //   - the literal word "secret"
      //   - a string starting with "https://" inside the callsite snippet
      //   - the URL path component "/rest/" suggesting a webhook URL was
      //     interpolated into a log message
      const leakPatterns: { name: string; pattern: RegExp }[] = [
        { name: 'literal url identifier', pattern: /\burl\b/i },
        { name: 'literal webhook identifier', pattern: /\bwebhook\b/i },
        { name: 'literal secret identifier', pattern: /\bsecret\b/i },
        { name: 'inline https URL', pattern: /https?:\/\//i },
        { name: 'inline /rest/ webhook path', pattern: /\/rest\//i },
      ]

      const callsites = findLoggerCallsites()
      const offenders: string[] = []

      for (const cs of callsites) {
        for (const { name, pattern } of leakPatterns) {
          if (pattern.test(cs.snippet)) {
            offenders.push(
              `[${name}] ${cs.file}:${cs.line}\n${cs.snippet
                .split('\n')
                .map((l) => '    ' + l)
                .join('\n')}`,
            )
          }
        }
      }

      // If this fails, see docs/SECURITY-AUDIT.md "Dependency-bump procedure".
      expect(
        offenders,
        `Found ${offenders.length} SDK logger callsite(s) that may leak webhook URL/secret. `
          + `Either prove the match is a false positive and refine the leak pattern, or refuse the SDK bump:\n\n`
          + offenders.join('\n\n'),
      ).toEqual([])
    })
  })

  describe('runtime scan of our useBitrix24 + useLogger wiring', () => {
    const SENTINEL_SECRET = 'XYZsentinel999LEAKCANARY'
    const FAKE_WEBHOOK = `https://example.bitrix24.ru/rest/1/${SENTINEL_SECRET}/`

    /**
     * Build a fresh logger backed by `MemoryHandler` so the test can inspect
     * every record the SDK or our wrapper produces. `DEBUG` level captures
     * everything — if the SDK ever logs URL at debug level (worst case), the
     * test catches it.
     */
    function makeMemoryLogger(): { logger: Logger; handler: MemoryHandler } {
      const handler = new MemoryHandler(LogLevel.DEBUG)
      const logger = Logger.create('sdk-leak-test')
      logger.pushHandler(handler)
      return { logger, handler }
    }

    function assertNoSecretLeak(records: LogRecord[], scope: string): void {
      const dump = JSON.stringify(records)
      // Two assertions: the secret itself AND any /rest/<digit>/ path that
      // would indicate a webhook URL is being interpolated somewhere. The
      // second catches mutated forms of the secret (e.g. percent-encoded,
      // truncated) where the verbatim sentinel might not match.
      expect(dump, `${scope}: webhook secret leaked into log records`).not.toContain(SENTINEL_SECRET)
      expect(dump, `${scope}: /rest/<id>/ webhook path shape leaked into log records`).not.toMatch(/\/rest\/\d+\//)
    }

    it('constructing the SDK hook from a secret-bearing URL logs nothing', () => {
      const { logger, handler } = makeMemoryLogger()
      const hook = B24Hook.fromWebhookUrl(FAKE_WEBHOOK)
      hook.setLogger(logger)
      assertNoSecretLeak(handler.getRecords(), 'hook construction + setLogger')
    })

    it('repeated setLogger calls do not leak the secret', () => {
      // Defends against a regression where the SDK starts emitting a "logger
      // already set" warning that includes the hook's identity (which could
      // contain URL data).
      const { logger, handler } = makeMemoryLogger()
      const hook = B24Hook.fromWebhookUrl(FAKE_WEBHOOK)
      hook.setLogger(logger)
      hook.setLogger(logger)
      hook.setLogger(logger)
      assertNoSecretLeak(handler.getRecords(), 'repeated setLogger')
    })

    it('SDK ≥1.1.2 baseline: the HTTP layer logs the bare method name, no URL leak even without our redactor', async () => {
      // Pins the upstream fix shipped in `@bitrix24/b24jssdk` 1.1.2 (issue
      // bitrix24/b24jssdk#39, PR #40, our tracker #38): the `post/send`
      // callsite in `core/http/abstract-http.mjs` now logs `method` (the
      // bare REST method name, e.g. `tasks.task.get`) instead of
      // `methodFormatted` (which embedded the full webhook URL incl. the
      // secret). Wire a RAW logger (no redaction) into a real B24Hook,
      // intercept the internal axios POST so no real network call happens,
      // and assert the captured logger context never contains the sentinel
      // secret — proving the SDK no longer leaks it at source.
      //
      // We still ship `makeRedactingLogger` in `server/utils/bitrix24.ts`
      // as defence in depth: if a future SDK bump re-introduces a leak,
      // our wrapper still scrubs it before it reaches the inner logger
      // (the dedicated defence test below proves that).
      //
      // If THIS test fails on a future bump, the SDK regressed — fix the
      // pin or extend `makeRedactingLogger` to cover the new shape, but
      // do NOT silently flip the assertion back. See `docs/SECURITY-AUDIT.md`.
      const { logger, handler } = makeMemoryLogger()
      const hook = B24Hook.fromWebhookUrl(FAKE_WEBHOOK)
      hook.setLogger(logger)
      await hook.init()
      const httpV3 = hook.getHttpClient(ApiVersion.v3) as unknown as {
        _clientAxios: { post: (...args: unknown[]) => Promise<unknown> }
      }
      httpV3._clientAxios.post = () =>
        Promise.resolve({ status: 200, data: { result: { item: {} }, time: {} } })

      await hook.actions.v3.call.make({ method: 'tasks.task.get', params: { taskId: 1 } })

      assertNoSecretLeak(handler.getRecords(), 'SDK ≥1.1.2 HTTP call without downstream redactor')
    })

    it('defence in depth: `makeRedactingLogger` also keeps the secret out of records on an HTTP call', async () => {
      // SDK ≥1.1.2 already prevents the leak at source (test above). This
      // test pins our belt-and-suspenders layer: `makeRedactingLogger`
      // still scrubs any URL-shaped value that might enter the context.
      // Same setup as the baseline, but wrap the logger via the same
      // helper `server/utils/bitrix24.ts` uses — sentinel must not appear
      // in records, regardless of whether the SDK or the wrapper does
      // the redaction.
      const { logger, handler } = makeMemoryLogger()
      const hook = B24Hook.fromWebhookUrl(FAKE_WEBHOOK)
      hook.setLogger(makeRedactingLogger(logger))
      await hook.init()
      const httpV3 = hook.getHttpClient(ApiVersion.v3) as unknown as {
        _clientAxios: { post: (...args: unknown[]) => Promise<unknown> }
      }
      httpV3._clientAxios.post = () =>
        Promise.resolve({ status: 200, data: { result: { item: {} }, time: {} } })

      await hook.actions.v3.call.make({ method: 'tasks.task.get', params: { taskId: 1 } })

      assertNoSecretLeak(handler.getRecords(), 'HTTP call through redacting logger')
    })

    it('useBitrix24() wires the redacting logger so a non-URL env var value cannot leak via the rewrapped error', async () => {
      // Issue #26 also covers the wrapper path: `useBitrix24()` catches
      // a `fromWebhookUrl` parse failure and rewraps it with operator
      // hint text. The SDK's parse error message can include the
      // offending input verbatim — `Invalid webhook URL format: <input>`.
      // If the operator misconfigured the env var with a real-but-
      // malformed webhook string (still bearing a secret), an
      // unredacted rewrap leaks the secret into the user-facing error.
      // We pin that the rewrap runs `redactString` on the SDK reason.
      vi.resetModules()
      vi.stubGlobal('useRuntimeConfig', () => ({
        bitrix24WebhookUrl: `${FAKE_WEBHOOK}!!INVALID!!`,
      }))
      const { useBitrix24 } = await import('../../../server/utils/bitrix24')

      let captured: unknown
      try {
        useBitrix24()
      } catch (err) {
        captured = err
      }
      // We don't depend on whether SDK actually rejects the malformed
      // input — only that IF it does, the error our wrapper throws does
      // not contain the sentinel.
      if (captured) {
        const errString = String((captured as Error).message ?? captured)
        expect(errString, 'useBitrix24 rewrap leaked the webhook secret').not.toContain(SENTINEL_SECRET)
      }
    })
  })
})
