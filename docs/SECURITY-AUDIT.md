# Security audit

Track-record of security audits performed against the dependencies and surfaces
that handle credentials in this MCP. Update on every relevant dependency bump.

## SDK logger surface — webhook URL leak (issue #26)

### Why this audit matters

`server/utils/bitrix24.ts` wires the project's structured logger into the
Bitrix24 SDK via `client.setLogger(useLogger())`. The motivation is observability:
SDK-internal events (retries, rate-limit warnings, transport errors) flow into
the same sink as application logs.

The risk: the webhook URL `https://<portal>.bitrix24.<tld>/rest/<user_id>/<secret>/`
contains a secret. If any SDK code path ever logs that URL — on retry, on transport
error, in a debug message — the secret leaks to whatever sink the logger is wired
to (stdout, file, log aggregator, …). For a self-hosted MCP the impact is bounded;
for a hosted multi-tenant MCP it would be a serious credential disclosure.

The leaky-bucket retry logic runs INSIDE the SDK. If a transport error during
retry includes the full URL in its message, the SDK has the option to log it.
Our wrapper has no way to redact log content after the fact.

### Audit pass — SDK 1.1.1 (2026-05)

**Method**: enumerated every `_logger.*` / `logger.*` callsite in the installed SDK
source tree (`node_modules/@bitrix24/b24jssdk/dist/esm/`), and audited every direct
`console.*` call. Each callsite's logged payload was inspected against the question
"could this expose the webhook URL or secret?".

**Findings**:

1. **Total `_logger.*` callsites in SDK 1.1.1**: 8 — all in `core/actions/{v2,v3}/{call-list,fetch-list}.mjs`.
   - 4 `_logger.warning(<static string>)` — log a fixed prose message about ignored
     `order` parameter. No dynamic content, no URL.
   - 4 `_logger.error("<methodLabel>", { method, requestId, messages })` — log the
     REST method name (e.g. `tasks.task.get`), an internal request id, and
     server-returned error messages. **No URL, no secret.**

2. **Direct `console.*` calls in `core/actions/*`**: 13 matches — all are in
   JSDoc `@example` blocks (`* console.log(...)` with the `*` prefix). No runtime
   console use in the action layer.

3. **HTTP layer (`core/http/`)**: zero `_logger.*` or `console.*` calls. The
   transport code does not log the URL at any point.

4. **Hook layer (`hook/`)**: zero `_logger.*` or `console.*` calls. The
   `B24Hook.fromWebhookUrl` parser does not log the input URL on success or on
   parse failure (it throws — the caller in `server/utils/bitrix24.ts` rewraps).

5. **`RestrictionManager` / `AdaptiveDelayer`**: no logger calls. Rate-limit
   handling is silent at the SDK level (the application is free to log via the
   leaky-bucket events if exposed, but the SDK does not auto-log them).

6. **AjaxError / SdkError**: `AjaxError.formatErrorMessage` includes the URL only
   if `requestInfo.url` is populated. Inspecting the call sites in `core/http/`,
   `requestInfo` is constructed with `{ method, params, requestId }` — `url` is
   never set. Verified at SDK 1.1.1.

**Conclusion**: at SDK 1.1.1 the webhook URL never reaches a log line. The wiring
in `server/utils/bitrix24.ts` is safe to keep.

### Regression test

`tests/unit/utils/sdk-logger-leak.test.ts` is a CI gate:

- **Static scan**: enumerates every `_logger.*` callsite in the installed SDK
  source tree and asserts NONE of them contain URL-shaped literals or
  URL-component variable names in the captured arguments. A future SDK bump
  that adds a leaky callsite will fail this scan immediately.
- **Runtime scan**: constructs `useBitrix24()` against a fake webhook URL
  containing a known sentinel secret, wires a `MemoryHandler`-backed logger,
  exercises every code path that runs without network (init, error rewrap on
  malformed URL, repeated calls to confirm singleton behaviour), and asserts
  the sentinel string never appears in any captured log record or thrown error
  message.

These two together catch the regression model: an SDK that starts logging the
URL fails the static scan; a wrapper-side change in our own code that
accidentally surfaces the URL fails the runtime scan.

### Dependency-bump procedure

When bumping `@bitrix24/b24jssdk` (`package.json` change):

1. Run `pnpm test --run tests/unit/utils/sdk-logger-leak.test.ts` — must pass.
2. If the static scan fails (new `_logger.*` callsite in the bumped SDK), read
   the new callsite's logged payload. If it contains URL-shaped data, OPEN AN
   ISSUE and HOLD the bump.
3. Update the "Audit pass" section above with the new SDK version, callsite
   count, and a one-line description of each new callsite.
4. Re-run the integration suite (`tests/integration/`) against a live portal to
   confirm no behaviour regressions before merging the bump.

Skipping the audit on a bump means trusting the SDK maintainers' judgement
about credential disclosure — that trust should be re-established on every
major version, not assumed across bumps.
