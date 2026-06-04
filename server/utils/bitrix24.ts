import { B24Hook, ParamsFactory } from '@bitrix24/b24jssdk'
import { makeRedactingLogger, redactString } from '~/server/utils/logger-redactor'
import { useLogger } from '~/server/utils/logger'

let client: B24Hook | null = null

/**
 * Bitrix24 tasks error `1048582` — "Действие не доступно" / "action not
 * available": the permanent rejection returned when a lifecycle transition is
 * invalid from the current status (e.g. pausing an already-paused task).
 *
 * TEMPORARY LOCAL FIX (#127 / upstream `bitrix24/b24jssdk#46`): the SDK's
 * `RestrictionManager` only skips retries for codes it recognises as hard/soft;
 * an unrecognised numeric code like this one is treated as transient and
 * retried 3× with backoff (~7s wasted) before failing. Registering it as a
 * `hardErrorCode` makes the SDK throw on the first attempt — matching how the
 * same error already behaves for `tasks.task.start` (which surfaces as
 * `ERR_BAD_REQUEST`). REMOVE this once the SDK ships the fix upstream (#46).
 */
const TASKS_ACTION_NOT_AVAILABLE_CODE = '1048582'

/**
 * Returns a process-singleton Bitrix24 client backed by the incoming webhook
 * configured via `NUXT_BITRIX24_WEBHOOK_URL`.
 *
 * Rate limiting / retry / adaptive back-pressure are provided by the SDK's
 * own `RestrictionManager` — initialised in `B24Hook`'s constructor with
 * `ParamsFactory.getDefault()` (standard tariff: burst 50, drain 2 req/sec,
 * adaptive delay on 503 / QUERY_LIMIT_EXCEEDED, 3 retries with backoff). We
 * do NOT wrap or monkey-patch any SDK method — the SDK already does this
 * correctly, with knowledge of Bitrix24's server-side leaky bucket.
 *
 * To override the defaults (Enterprise tariff, batch profile, custom retry):
 *   const client = useBitrix24()
 *   await client.setRestrictionManagerParams(ParamsFactory.getEnterprise())
 * The SDK also exposes `getRestrictionManagerParams()` and `getStats()` for
 * introspection.
 *
 * REST calls go through `client.actions.v3.call.make({ method, params })`
 * for v3 methods (currently `tasks.task.get`, `tasks.task.result.*`) and
 * `client.actions.v2.call.make` for v2 (`tasks.task.{add,list,update,…}`,
 * `user.*`, `task.commentitem.*`, `task.checklistitem.*`, …). The deprecated
 * `callMethod` is
 * forbidden — it disappears in SDK 2.0. Use the {@link callV3} / {@link callV2}
 * helpers from `server/utils/sdk-helpers.ts` instead of calling `actions.*`
 * directly — they own the `isSuccess` / `getErrorMessages` boilerplate.
 *
 * Direct callers should use `useBitrix24Tenant()` (in
 * `~/server/utils/bitrix24-tenant`) instead — it returns this same
 * singleton when OAuth is disabled and routes to per-tenant `B24OAuth`
 * instances when OAuth is enabled (PR-2c). Calling `useBitrix24()`
 * directly bypasses the OAuth dispatcher and is appropriate only for
 * pure-webhook code paths (e.g. the dispatcher's own fallback branch).
 *
 * Phase 1 uses the webhook flow only. Phase 3 will introduce useBitrix24OAuth()
 * alongside this helper without changing its signature.
 *
 * The cache lives in module scope, so tests that need a clean state should
 * `vi.resetModules()` and re-import this module — we deliberately do not
 * export a reset hook to avoid leaking test-only API into production builds.
 *
 * @throws {Error} when `NUXT_BITRIX24_WEBHOOK_URL` is missing — the operator
 *   has not finished the deployment. The message includes the env-var name
 *   so the fix is self-evident.
 * @throws {Error} when `NUXT_BITRIX24_WEBHOOK_URL` is malformed — propagated
 *   from `B24Hook.fromWebhookUrl(url)` but re-wrapped with a hint pointing at
 *   the expected URL shape, so the SDK's raw parse error doesn't surface to
 *   the operator with no context.
 */
export function useBitrix24(): B24Hook {
  if (client) return client

  const { bitrix24WebhookUrl } = useRuntimeConfig()
  if (!bitrix24WebhookUrl) {
    throw new Error('NUXT_BITRIX24_WEBHOOK_URL is not configured')
  }

  // SDK 1.1+ no longer accepts a raw URL in the constructor — the helper
  // parses portal host, user id, and secret out of the webhook URL. The
  // parse throws on malformed input; rewrap so the operator sees the
  // expected shape, not a raw stack from the SDK.
  try {
    client = B24Hook.fromWebhookUrl(bitrix24WebhookUrl)
  } catch (err) {
    // SECURITY (#26): the SDK parse error message can include the offending
    // URL verbatim — e.g. `Invalid webhook URL format: <input>`. If the
    // operator misconfigured the env var with a real-but-malformed webhook
    // string, that URL contains the secret. Run the SDK reason through the
    // same redactor we wrap the logger with so the secret never reaches the
    // rewrapped error message (which could be logged by Nuxt's error
    // handler).
    const rawReason = err instanceof Error ? err.message : String(err)
    const reason = redactString(rawReason)
    throw new Error(
      `NUXT_BITRIX24_WEBHOOK_URL is not a valid Bitrix24 webhook URL `
        + `(expected https://<portal>.bitrix24.<tld>/rest/<user_id>/<secret>/): ${reason}`,
    )
  }

  // Wire the SDK's internal events (retry, rate-limit, errors) into the
  // project-wide structured logger. One sink for app + SDK events.
  //
  // SECURITY (#26 / upstream #38 / `bitrix24/b24jssdk` #39): SDK 1.1.1's
  // HTTP layer logged the full request URL — `https://<portal>/rest/<userId>/<SECRET>`
  // — on every call via `getLogger().info('post/send', ...)` in
  // `core/http/abstract-http.mjs`, leaking the webhook secret to every
  // sink the logger ships to. SDK 1.1.2 (PR #40) fixed it at source by
  // logging the bare REST method name instead. We still wrap with
  // `makeRedactingLogger` as defence in depth: any future regression that
  // re-introduces a URL anywhere in the logger surface is scrubbed before
  // it reaches the inner logger. See `server/utils/logger-redactor.ts` and
  // `docs/SECURITY-AUDIT.md` (with the dependency-bump procedure).
  client.setLogger(makeRedactingLogger(useLogger()))

  // Register the permanent tasks rejection code as non-retryable (see
  // TASKS_ACTION_NOT_AVAILABLE_CODE above). `setRestrictionManagerParams`
  // assigns the manager's config synchronously (before its first await), so
  // the code is in effect before any request runs even though we don't await
  // here; we only guard the async tail (limiter re-config) against an
  // unhandled rejection. The base params mirror the SDK constructor's default.
  const params = ParamsFactory.getDefault()
  void client
    .setRestrictionManagerParams({
      ...params,
      hardErrorCodes: [...(params.hardErrorCodes ?? []), TASKS_ACTION_NOT_AVAILABLE_CODE],
    })
    .catch((err: unknown) => {
      useLogger().error('Failed to register Bitrix24 hard error code 1048582', { err })
    })

  return client
}
