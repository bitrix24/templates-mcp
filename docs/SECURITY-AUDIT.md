# Security audit

Track-record of security audits performed against the dependencies and surfaces
that handle credentials in this MCP. Update on every dependency bump that
touches a credential-adjacent surface.

## SDK logger surface — webhook URL leak (issue #26)

### Why this audit matters

`server/utils/bitrix24.ts` wires the project's structured logger into the
Bitrix24 SDK via `client.setLogger(useLogger())`. The motivation is observability:
SDK-internal events (retries, rate-limit warnings, transport errors) flow into
the same sink as application logs.

The risk: the webhook URL `https://<portal>.bitrix24.<tld>/rest/<user_id>/<secret>/`
contains a secret. If any SDK code path logs that URL — on retry, on transport
error, in a debug message — the secret leaks to whatever sink the logger is wired
to (stdout, file, log aggregator). For a self-hosted MCP the impact is bounded;
for a hosted multi-tenant MCP it would be a serious credential disclosure.

### Audit pass — SDK 1.1.1 (2026-05)

**Method**: enumerated every `_logger.*`, `getLogger().*`, and direct `console.*`
callsite in the installed SDK source tree (`node_modules/@bitrix24/b24jssdk/dist/esm/`).
Each callsite's logged payload was inspected against the question "could this
expose the webhook URL or secret?".

**Findings — `_logger.*` / `getLogger().*` callsites**:

1. **Action layer** (`core/actions/{v2,v3}/{call-list,fetch-list}.mjs`):
   8 callsites total — 4 `_logger.warning(<static string>)` and
   4 `_logger.error("<methodLabel>", { method, requestId, messages })`.
   No URL, no secret. **Safe.**

2. **HTTP layer** (`core/http/abstract-http.mjs`):
   13 callsites via `this.getLogger().<level>(...)`. **Three of them leak the
   webhook URL** at INFO level on every API request:

   - `getLogger().info('post/send', { requestId, method: methodFormatted, params })`
     — line 334.
   - `getLogger().info('post/response', { requestId, result, time })` — line 344.
   - `getLogger().info('post/catchError', { requestId, status, responseData })`
     — line 309 (on retry / error path).

   `methodFormatted` is built by `_prepareMethod(requestId, method, getBaseUrl())`
   where `getBaseUrl()` returns `https://<portal>/rest/<userId>/<SECRET>` for
   v2 and `https://<portal>/rest/api/<userId>/<SECRET>` for v3. So every
   `client.actions.{v2,v3}.call.make(...)` call writes the full secret-bearing
   URL into the logger context's `method` field.

   The remaining 10 callsites in the HTTP layer (retry / auth-refresh /
   batch lifecycle, lines 441–536) log `method` (the REST method name,
   not the URL), `requestId`, attempt counters, etc. **Safe by themselves.**

3. **Hook layer** (`hook/`), **RestrictionManager**, **PullClient**, **OAuth**:
   no logger callsites that touch the URL on the inspected paths. PullClient
   and OAuth are out-of-scope for this MCP's hook flow but were checked for
   completeness.

**Findings — direct `console.*`**:

4. **`core/actions/*`**: 14 matches across v2 + v3 — all are inside JSDoc
   `@example` blocks (lines start with `*` — the doc-comment prefix), not
   runtime code. Safe.

5. **`logger/browser.mjs`**: 12+ live `console.warn(deprecateMessage)` calls.
   **Out of scope for this MCP**: we run in Nitro (Node.js), not the browser
   handler — these callsites never fire. Documented here so the next auditor
   doesn't re-investigate; if we ever ship a browser build, re-audit.

6. **`pullClient/protobuf.mjs`**: ships with protobuf.js runtime code that
   contains `console.*` in error paths. Pull is not used by this MCP — out
   of scope.

**Findings — error-message paths**:

7. `AjaxError.toString()` (and `formatErrorMessage`) include `requestInfo.url`
   only if that field is set. Inspecting the HTTP-layer construction of
   `requestInfo`, the URL is **not** populated — only `{ method, params,
   requestId }`. Verified at SDK 1.1.1.

8. `B24Hook.fromWebhookUrl(malformed)` throws an `Error` whose message
   includes the offending input verbatim (e.g. `Invalid webhook URL
   format: <input>`). Our `useBitrix24()` wrapper used to interpolate
   that message into its own rewrapped error — fixed in this PR by
   running the SDK reason through `redactString()` before interpolation.

**Conclusion**: SDK 1.1.1 actively leaks the webhook URL through the HTTP
layer's `getLogger().info('post/send', ...)` callsite. The audit's original
claim of "HTTP layer: zero log calls" was based on a regex matching only
`_logger.*` — which missed the entire `getLogger().*` pattern used by the
HTTP layer. This PR (`fix(security)`) ships the mitigation.

### Mitigation in this PR

**`server/utils/logger-redactor.ts`** — `makeRedactingLogger(inner)` wraps
any `LoggerInterface` and scrubs Bitrix24 webhook URLs out of every
`message` and `context` argument before passing them to the inner logger.
Two-shape regex covers both v2 (`/rest/<id>/<secret>`) and v3
(`/rest/api/<id>/<secret>`); the secret segment becomes `<REDACTED>` while
the portal hostname, user id, and trailing method path are preserved for
debugging.

**`server/utils/bitrix24.ts`** — wires the redactor between `useLogger()`
and the SDK:

```ts
client.setLogger(makeRedactingLogger(useLogger()))
```

Plus the malformed-URL rewrap now runs `redactString(reason)` before
interpolating the SDK parse-error message into the operator-facing error.

**Upstream fix** — Bitrix24 should redact at the SDK level: the audit
found that `getLogger().info('post/send', { method: methodFormatted })`
logs the full URL on every call. We are reporting this upstream; once
they ship the fix our `makeRedactingLogger` becomes belt-and-suspenders
rather than the primary defence. We keep it regardless: redundant
credential protection is cheap, and we don't trust SDK release notes to
call out logger surface regressions on every bump.

### Regression test

`tests/unit/utils/sdk-logger-leak.test.ts` is a CI gate with two layers:

- **Static scan** — enumerates every `_logger.*` and `getLogger().*`
  callsite in the installed SDK source tree, captures a 9-line snippet
  around each, and asserts none of them contain obvious URL-shaped
  literals or URL-component identifiers (`url`, `webhook`, `secret`,
  inline `https://`, `/rest/`). **This is a heuristic** — it catches
  SDK regressions where new callsites name the URL explicitly, but
  does NOT catch the existing `methodFormatted` variable-routed leak
  (the variable name doesn't match any leak pattern). The runtime tests
  below carry the real load.
  - Sanity baselines: ≥50 SDK files scanned, ≥30 logger callsites
    found. If either drops sharply, the matcher has gone blind to a
    chunk of the SDK — fail loud so the maintainer extends the pattern.

- **Runtime tests** — these prove the defence works end-to-end:
  - **BASELINE**: wire a RAW logger (no redaction) into a real `B24Hook`,
    intercept the internal axios POST, trigger an API call, assert the
    sentinel secret DOES appear in captured logs. This proves the
    leak we're defending against is real; if it ever STOPS finding
    the leak, SDK upstream fixed it (update this doc).
  - **DEFENCE**: same setup but with `makeRedactingLogger` wrapping
    the logger. Assert the sentinel does NOT appear in captured logs.
  - **WRAPPER REWRAP**: load `useBitrix24` against a malformed env-var
    URL bearing the sentinel; assert the thrown error does not
    contain the sentinel (covers the `redactString(reason)` path).

`tests/unit/utils/logger-redactor.test.ts` separately unit-tests the
redactor itself: regex coverage for v2 and v3 URL shapes, deep-walk
correctness, no-mutation guarantee, every `LoggerInterface` method
wrapped.

### Dependency-bump procedure

When bumping `@bitrix24/b24jssdk` (`package.json` change):

1. Run `pnpm test --run tests/unit/utils/sdk-logger-leak.test.ts` and
   `pnpm test --run tests/unit/utils/logger-redactor.test.ts` — must
   pass. If the static scan fails, read the offending file:line and
   prove the match is a false positive (refine the pattern) OR refuse
   the bump.
2. If the **BASELINE** test starts FAILING (the sentinel no longer
   appears in captured logs), SDK upstream may have fixed the leak.
   Re-audit by hand; if confirmed, update this doc and consider
   downgrading `makeRedactingLogger` to belt-and-suspenders status
   (but keep it — defence in depth).
3. Update the "Audit pass" section above with the new SDK version,
   the new callsite count per surface, and a one-line description of
   each new callsite that touches a URL-shaped field.
4. Re-run the integration suite (`tests/integration/`) against a live
   portal to confirm no behaviour regressions.

Skipping the audit on a bump means trusting the SDK maintainers'
judgement about credential disclosure — re-establish that trust on
every bump (not just majors), because a minor or patch can add a new
logger callsite as easily as a major.
