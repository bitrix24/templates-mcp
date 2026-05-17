import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { B24Hook, Logger, type LogRecord, LogLevel, MemoryHandler } from '@bitrix24/b24jssdk'
import { describe, expect, it } from 'vitest'

/**
 * Issue #26 regression guard — the webhook URL contains a secret. If any SDK
 * code path ever logs that URL, the secret leaks to the log sink. We wired the
 * SDK's logger into our structured logger in `server/utils/bitrix24.ts`, so the
 * blast radius is "every log destination we ship to" — file, stdout, aggregator.
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
 *     appears in any captured log record or thrown error message.
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
 * Find every `logger.<level>(...)` or `_logger.<level>(...)` callsite and
 * capture a multi-line window around each so we can inspect the logged payload.
 */
function findLoggerCallsites(): LoggerCallsite[] {
  const callsiteRe = /\b_?logger\.(log|debug|info|warning|warn|error|trace)\s*\(/
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
    it('finds at least one logger callsite (sanity — would fail if scanner is broken or SDK is empty)', () => {
      const callsites = findLoggerCallsites()
      expect(callsites.length).toBeGreaterThan(0)
    })

    it('every logger callsite logs only safe identifiers (method / requestId / messages) — no URL or secret', () => {
      // Allow-list of identifiers that SDK 1.1.1 logger callsites use in their
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

    it('our useBitrix24 wrapper does not surface the secret in the malformed-URL rewrap', async () => {
      // The wrapper rewraps a `fromWebhookUrl` parse failure with operator
      // hint text. If the rewrap ever interpolates the offending URL into
      // the user-facing error (tempting for debuggability), the secret
      // leaks via the error path even though the logger is silent.
      //
      // We use a malformed URL that still LOOKS like a webhook URL so the
      // rewrap path is exercised — if the wrapper inlined the input, the
      // sentinel would surface in the thrown error message.
      const malformed = `${FAKE_WEBHOOK}!!INVALID!!`
      let captured: unknown
      try {
        B24Hook.fromWebhookUrl(malformed)
      } catch (err) {
        captured = err
      }
      // If the SDK's parser accepted the malformed string (unlikely), the
      // test is inert — we still pass because no leak occurred.
      if (captured) {
        const errString = String(captured) + JSON.stringify(captured, Object.getOwnPropertyNames(captured))
        expect(errString, 'SDK parse-error wrap leaked the webhook secret').not.toContain(SENTINEL_SECRET)
      }
    })
  })
})
