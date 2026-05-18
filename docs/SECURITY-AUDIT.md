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

### Audit pass — SDK 1.1.2 (2026-05)

**Upstream status**: the 1.1.1 leak documented below was reported upstream as
[`bitrix24/b24jssdk#39`][upstream-39] (our tracker: [#38][downstream-38]) and
fixed in [PR `bitrix24/b24jssdk#40`][upstream-40], shipped in SDK
**1.1.2** (2026-05-18). We bumped `@bitrix24/b24jssdk` and
`@bitrix24/b24jssdk-nuxt` from `^1.1.1` to `^1.1.2` in this PR.

[upstream-39]: https://github.com/bitrix24/b24jssdk/issues/39
[upstream-40]: https://github.com/bitrix24/b24jssdk/pull/40
[downstream-38]: https://github.com/bitrix24/templates-mcp/issues/38

**What 1.1.2 changed**:

1. The `post/send` callsite in `core/http/abstract-http.mjs` now logs
   `method` (the bare REST method name, e.g. `tasks.task.get`) instead of
   `methodFormatted` (which embedded the full webhook URL). No URL, no
   secret enters the logger context on the success path.
2. A new helper `core/http/redact.mjs` (`redactSensitiveParams`) walks the
   serialised `params` blob and replaces values under known credential-bearing
   keys (`auth`, `password`, `token`, `secret`, `access_token`, `refresh_token`)
   with `***REDACTED***`. Applied at `post/send` and at `post/catchError` so
   future portal responses that embed credentials in error bodies are also
   scrubbed. Depth-2 walk covers batch-shaped payloads (`cmd[i].params.<key>`).
3. The unused `url` field was removed from `AjaxError`'s `requestInfo` typing
   and error rendering, eliminating a latent re-introduction path.

**Verification**: `tests/unit/utils/sdk-logger-leak.test.ts` was updated to
flip the BASELINE assertion. It now wires a RAW logger (no downstream
redactor) into a real `B24Hook`, exercises an API call against a stubbed
axios, and asserts the sentinel secret does NOT appear in captured records.
This pins the upstream fix as a regression guard — if a future SDK bump
re-introduces a URL in the logger context, the baseline test fails
immediately. Static scan unchanged (still enumerates all `_logger.*` /
`getLogger().*` callsites and asserts no URL-shaped literals near them).

**Downstream redactor (`makeRedactingLogger`)**: kept wired in
`server/utils/bitrix24.ts` as defence in depth. The wrapper is no longer the
primary defence — SDK ≥1.1.2 is — but the cost is negligible and SDK release
notes don't always call out logger-surface regressions on every bump. A
dedicated "defence in depth" test asserts the wrapper still scrubs URL-shaped
values regardless of what the SDK does. The `useBitrix24()` malformed-URL
rewrap also keeps running `redactString(reason)` on the SDK parse error
message (still relevant — that path doesn't go through the SDK logger).

**Known SDK gap (out of scope for this PR)**: SDK 1.1.2's `redactSensitiveParams`
is applied to outbound `params` (in `post/send`) and to error response bodies
(in `post/catchError`), but **not** to successful response bodies in
`post/response` — `result: JSON.stringify(response.data.result, null, 0)` is
logged as-is. If a Bitrix24 portal endpoint ever returns a credential under a
sensitive key (`auth` / `token` / …) in its happy-path `result`, that value
reaches the logger context unredacted. No current REST method in this MCP's
tool surface returns such fields; documented here so a future auditor knows
where to look first. Tracked as `it.todo` in
`tests/unit/utils/sdk-logger-leak.test.ts` so the gap stays visible on
every test run until SDK closes it or we extend `makeRedactingLogger`
with key-based redaction.

#### Partial mitigation via URL-pattern scrubbing

`makeRedactingLogger` does **not** close the key-dimension gap above —
it only knows about URL-shaped strings. If a future SDK / portal
combination places a non-URL credential (a bare `access_token` value, a
password string) under a sensitive key in `response.data.result`, our
wrapper passes it through unmodified.

The wrapper *does* run on every `logger.<level>(...)` call (including
`post/response`), so if a portal somehow embedded a full webhook URL
inside `result`, the secret segment of that URL would still be
scrubbed. This is incidental coverage, not the defence the gap calls
for. The fix when the gap matters: either upstream-redact at SDK
level, or extend `makeRedactingLogger` with key-based scrubbing
mirroring SDK's `SENSITIVE_PARAM_KEYS`.

### Operator action required (deployments on SDK 1.1.x ≤ 1.1.1)

If any deployment of this MCP ran on `@bitrix24/b24jssdk` 1.1.1 — or on
1.1.0 [^1.1.0-scope] — the webhook URL, including the secret path
segment, was written to every log sink wired via `setLogger(...)` on
**every** Bitrix24 API call. Before treating this PR as "done":

[^1.1.0-scope]:
    1.1.0 included by inspection: the same `post/send` callsite with
    `method: methodFormatted` existed in that release. The audit
    didn't separately install and exercise 1.1.0, so verification is
    by reasoning, not by run. Operators with a historical lockfile
    pinning 1.1.0 (`pnpm-lock.yaml`, `package-lock.json`,
    `yarn.lock`) should treat the deployment as in-scope unless they
    can confirm from that lockfile's resolved SDK source that the
    leaky callsite was absent.

1. **Audit log sinks.** Grep historical log retention (stdout capture, file
   archives, aggregator queries) for the pattern `/rest/<digits>/` or the
   `<portal>.bitrix24.<tld>` host of the affected webhook. Any match is the
   secret in plaintext.
2. **Rotate the webhook.** In the Bitrix24 portal admin (Applications →
   Webhooks), revoke the leaked incoming webhook and issue a new one. Update
   `NUXT_BITRIX24_WEBHOOK_URL` in every environment (`.env`, secrets manager,
   deployment platform) to point at the new URL. The old secret is
   compromised the moment a log sink with retention has seen it.
3. **Notify downstream consumers.** If this MCP's webhook was shared with
   other internal services or operators, tell them the secret rotated and
   provide the new URL through a non-logged channel.
4. **Tighten log access.** As a follow-up, review who has read access to log
   sinks that retained historical entries during the affected window —
   credential disclosure scope = "everyone with log access".
5. **Review retention and consult your DPO if regulated.** If historical
   log entries containing the webhook URL survived to disk / aggregator,
   assess whether your retention policy and applicable regulations
   (GDPR Art. 33, CCPA, sector-specific frameworks) require purging the
   affected records or notifying a Data Protection Officer / regulator.
   For on-prem deployments, truncate the relevant log-file window; for
   aggregators (Datadog, Elastic, Splunk), use their targeted-deletion
   / PII-scrubbing APIs. This section is not legal advice — escalate to
   your DPO / counsel for jurisdiction-specific requirements.

This guidance mirrors the upstream 1.1.2 release notes recommendation
("audit historical log sinks … rotate the corresponding credentials").
Deployments that always ran on ≤1.0.x or that never wired a logger via
`setLogger` are not affected by this specific leak.

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
logs the full URL on every call. We reported this upstream as
[`bitrix24/b24jssdk#39`][upstream-39] (downstream tracker
[#38][downstream-38]) and the fix shipped in SDK 1.1.2
([PR #40][upstream-40]) — see the "Audit pass — SDK 1.1.2" section
above. `makeRedactingLogger` stays wired as defence in depth:
redundant credential protection is cheap, and we don't trust SDK
release notes to call out logger surface regressions on every bump.

### Regression test

`tests/unit/utils/sdk-logger-leak.test.ts` is a CI gate with two layers:

- **Static scan** — enumerates every `_logger.*` and `getLogger().*`
  callsite in the installed SDK source tree, captures a 9-line snippet
  around each, and asserts none of them contain obvious URL-shaped
  literals or URL-component identifiers (`url`, `webhook`, `secret`,
  inline `https://`, `/rest/`). **This is a heuristic** — it catches
  SDK regressions where new callsites name the URL explicitly, but
  does NOT catch a variable-routed leak (like SDK 1.1.1's
  `methodFormatted` — the variable name didn't match any leak pattern).
  The runtime tests below carry the real load.
  - Sanity baselines (as of SDK 1.1.2): ≥50 SDK files scanned (~107
    actual), ≥60 logger callsites found (~81 actual — 8 `_logger.*` in
    the action layer + ~73 `getLogger().*` across HTTP / pull / frame /
    helper). If either drops sharply, the matcher has gone blind to a
    chunk of the SDK — fail loud so the maintainer extends the pattern.

- **Runtime tests** — these prove the defence works end-to-end:
  - **BASELINE** (SDK ≥1.1.2 upstream fix): wire a RAW logger (no
    redaction) into a real `B24Hook`, intercept the internal axios POST,
    trigger an API call, assert the sentinel secret does **NOT** appear
    in captured logs. This pins the upstream fix as a regression guard;
    if a future SDK bump re-introduces a URL in the logger context,
    this test fails immediately.
  - **DEFENCE**: same setup but with `makeRedactingLogger` wrapping the
    logger. Assert the sentinel does not appear in captured logs.
  - **SDK SENSITIVE-PARAM REDACTION**: pass `params: { auth: SENTINEL }`
    on `post/send` and trigger an `AxiosError` with
    `response.data = { auth: SENTINEL }` on `post/catchError`; assert
    SDK's `redactSensitiveParams` keeps the sentinel out of captured
    logs in both paths.
  - **WRAPPER REWRAP**: load `useBitrix24` against a malformed env-var
    URL bearing the sentinel; assert the thrown error does not contain
    the sentinel (covers the `redactString(reason)` path).

`tests/unit/utils/logger-redactor.test.ts` separately unit-tests the
redactor itself: regex coverage for v2 and v3 URL shapes, deep-walk
correctness, no-mutation guarantee, every `LoggerInterface` method
wrapped.

### Dependency-bump procedure

When bumping `@bitrix24/b24jssdk` or `@bitrix24/b24jssdk-nuxt`
(`package.json` change — both packages share the underlying HTTP /
logger surface, so a bump to either triggers this procedure):

1. Run `pnpm test --run tests/unit/utils/sdk-logger-leak.test.ts` and
   `pnpm test --run tests/unit/utils/logger-redactor.test.ts` — must
   pass. If the static scan fails, read the offending file:line and
   prove the match is a false positive (refine the pattern) OR refuse
   the bump.
2. If the **BASELINE** test starts FAILING (the sentinel **appears** in
   captured logs with a raw logger), the SDK regressed — a code path
   re-introduced a URL or other secret-bearing value into the logger
   context. Do **not** silently flip the assertion back to "expect leak"
   to make CI green. Either fix the regression upstream (report on
   `bitrix24/b24jssdk`) and refuse the bump until the next patch, or
   extend `makeRedactingLogger` to cover the new shape and document the
   gap here. The wrapper is defence in depth; SDK source is the
   primary defence.
3. If new sensitive-key shapes appear in SDK release notes (e.g. SDK
   adds a new param name to its `redactSensitiveParams` whitelist),
   mirror the addition in the **SDK SENSITIVE-PARAM REDACTION** runtime
   tests so any future removal from the SDK whitelist is caught.
4. Update the "Audit pass" section above with the new SDK version,
   the new callsite count per surface, and a one-line description of
   each new callsite that touches a URL-shaped field. If callsite count
   shifted >25% from the previous baseline, retune the sanity
   thresholds in `sdk-logger-leak.test.ts` so dramatic drops still
   fail loud.
5. Re-run the integration suite (`tests/integration/`) against a live
   portal to confirm no behaviour regressions.

Skipping the audit on a bump means trusting the SDK maintainers'
judgement about credential disclosure — re-establish that trust on
every bump (not just majors), because a minor or patch can add a new
logger callsite as easily as a major.
