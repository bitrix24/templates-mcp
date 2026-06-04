import type {
  AjaxResult,
  BatchCommandsArrayUniversal,
  CallBatchResult,
  TypeB24,
  TypeCallParams,
} from '@bitrix24/b24jssdk'
import { Bitrix24ToolError, toToolError } from '~/server/utils/errors'

/**
 * Thin typed wrappers over `b24.actions.v{2,3}.{call,batch}.make` that
 * collapse the four-line "await + isSuccess + getErrorMessages + getData"
 * dance into one call. Each helper:
 *
 *   - Wraps transport-level throws via `toToolError`.
 *   - Maps `response.isSuccess === false` to a `Bitrix24ToolError` with the
 *     SDK's joined error messages (or the provided `errorContext` fallback).
 *   - Returns the unwrapped payload (or array of `AjaxResult` rows for batch).
 *
 * Why centralise: every tool handler used to repeat the same pattern with
 * subtle drift. One helper means one spot to audit error semantics, one spot
 * to type the SDK boundary, and one spot to update if the SDK contract
 * changes.
 *
 * See `skills/manage-bx24-template-mcp/adding-tools.md` for the canonical
 * usage template.
 *
 * Type story: the SDK types `params?: TypeCallParams` (object-shaped) on
 * v2/v3 call.make, but the runtime serialiser also accepts positional
 * arrays — some v2 endpoints (`task.checklistitem.{complete,renew,delete}`)
 * are documented with positional params only. We expose this via overloads
 * so each callsite picks the right shape and TypeScript carries the right
 * type through. The one localised cast that remains for the array case
 * (single `as TypeCallParams`, with a comment at the boundary) is the
 * unavoidable cost of an SDK type that doesn't model positional params.
 */

/**
 * TRANSPORT CONVENTION (read before adding a tool)
 * -------------------------------------------------
 * Bitrix24 runs two REST surfaces: the classic API (`/rest/<uid>/<secret>/…`,
 * UPPERCASE fields) reached via `callV2`/`batchV2`, and rest-v3
 * (`/rest/api/…`, camelCase DTOs, `BITRIX_REST_V3_EXCEPTION_*` errors) reached
 * via `callV3`/`batchV3`. They are NOT interchangeable — calling a classic
 * method on v3 yields `UNKNOWNDTOPROPERTYEXCEPTION` (wrong field casing) or
 * "restApi:v3 not support method".
 *
 * Bitrix24's migration to rest-v3 is gradual and will take a long time, so the
 * project default is **v2** for everything that has a classic implementation:
 *   - v2 (`callV2`):  `tasks.task.{add,list,update,start,pause,complete,`
 *                      `approve,disapprove,defer,renew}`, `user.*`,
 *                      `task.*` (singular: commentitem/checklistitem/…).
 *   - v3 (`callV3`):  only methods that are v3-ONLY with no working v2 form —
 *                      currently `tasks.task.get` and `tasks.task.result.*`.
 * When in doubt, check apidocs: a `/rest/api/` URL + camelCase fields = v3.
 */

/**
 * Call a v3 REST method and return its `result` payload.
 *
 * @param b24 — client from `useBitrix24Tenant()` (the tenant-aware dispatcher;
 *   falls back to the webhook singleton when OAuth is disabled).
 * @param method — REST method name (e.g. `tasks.task.get`).
 * @param params — params object (passed straight to `actions.v3.call.make`).
 * @param errorContext — fallback error message when the SDK gives nothing
 *   useful. Reads "Failed to <verb> Bitrix24 task <id>" / similar.
 * @returns The unwrapped `result` payload, or `undefined` if Bitrix24
 *   returned a success envelope with no body (rare; tool handlers should
 *   treat as a defensive branch).
 * @throws {Bitrix24ToolError} on `!isSuccess` or transport failure.
 */
export async function callV3<T>(
  b24: TypeB24,
  method: string,
  params: TypeCallParams,
  errorContext: string,
): Promise<T | undefined> {
  let response: AjaxResult<T>
  try {
    response = await b24.actions.v3.call.make<T>({ method, params })
  } catch (err) {
    throw toToolError(err, errorContext)
  }
  if (!response.isSuccess) {
    throw new Bitrix24ToolError(response.getErrorMessages().join('; ') || errorContext)
  }
  return response.getData()?.result
}

/**
 * Call a v2 REST method (`user.*`, `task.commentitem.*`,
 * `task.checklistitem.*`, …) and return its `result` payload. Same contract
 * as {@link callV3}.
 *
 * Accepts an object-shaped `TypeCallParams` for the common case (tasks list,
 * user search, etc.) OR a positional `unknown[]` for v2 methods documented with
 * positional args (e.g. `task.checklistitem.{complete,renew}`,
 * https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/). The
 * runtime serialiser handles both shapes; the union return keeps callers
 * cast-free.
 */
export async function callV2<T>(
  b24: TypeB24,
  method: string,
  params: TypeCallParams | unknown[],
  errorContext: string,
): Promise<T | undefined> {
  let response: AjaxResult<T>
  try {
    // The SDK only types positional params for some legacy v2 endpoints
    // (`task.checklistitem.{complete,renew}`) — the type signature accepts
    // only `TypeCallParams` (object-shaped). The runtime serialiser does
    // honour positional arrays; this single localised cast is the bridge.
    response = await b24.actions.v2.call.make<T>({
      method,
      params: Array.isArray(params) ? (params as unknown as TypeCallParams) : params,
    })
  } catch (err) {
    throw toToolError(err, errorContext)
  }
  if (!response.isSuccess) {
    throw new Bitrix24ToolError(response.getErrorMessages().join('; ') || errorContext)
  }
  return response.getData()?.result
}

/**
 * One batch call shape — used by both {@link batchV2} and {@link batchV3}:
 * a tuple of REST method name + params. Matches the array form of
 * `BatchCommandsArrayUniversal` from the SDK.
 *
 * Bitrix24's batch transport accepts both an object-shaped params and a
 * positional array (`[a, b]`) — some v2 endpoints, notably
 * `task.checklistitem.{complete,renew}`, are documented with positional
 * params only. The runtime serialiser handles both shapes; we widen the
 * tuple's second element to `TypeCallParams | unknown[]` so callers can
 * pass either without casting at the call site.
 */
export type BatchCall = [method: string, params: TypeCallParams | unknown[]]

// Implementation note for the `as Array<AjaxResult<T>>` cast used by both
// batchV3 and batchV2 below: with `returnAjaxResult: true` and a tuple-
// array `calls` shape, the SDK returns `Result<AjaxResult<T>[]>`. The
// union return type of `CallBatchResult<T>` covers two other shapes too
// (named-commands map, bare-payload) which we don't trigger here — the
// cast localises that single type-system gap. Runtime shape covered by
// every batch test in:
//   - tests/unit/utils/task-lifecycle.test.ts (lifecycle factory)
//   - tests/unit/tools/tasks/*checklist*.test.ts (checklist factory)
//   - tests/unit/utils/define-action-tool.test.ts (mapBatchRows core)

/**
 * Run multiple v3 calls in a single HTTP batch. Returns an array of
 * `AjaxResult<T>` rows aligned with the input order, so callers can map
 * 1:1 against their original ids.
 *
 * Use `returnAjaxResult: true` and `isHaltOnError: false` so per-call
 * failures don't abort the batch — each row carries its own `isSuccess` /
 * `getErrorMessages()`.
 *
 * @throws {Bitrix24ToolError} on transport failure or top-level
 *   `!isSuccess` (i.e. the whole batch envelope was rejected). Per-row
 *   failures do NOT throw — they land in the returned array.
 */
export async function batchV3<T>(
  b24: TypeB24,
  calls: BatchCall[],
  errorContext: string,
): Promise<Array<AjaxResult<T>>> {
  let response: CallBatchResult<T>
  try {
    response = await b24.actions.v3.batch.make<T>({
      calls: calls as BatchCommandsArrayUniversal,
      options: { isHaltOnError: false, returnAjaxResult: true },
    })
  } catch (err) {
    throw toToolError(err, errorContext)
  }
  if (!response.isSuccess) {
    throw new Bitrix24ToolError(response.getErrorMessages().join('; ') || errorContext)
  }
  return response.getData() as Array<AjaxResult<T>>
}

/**
 * Run multiple v2 calls in a single HTTP batch via `actions.v2.batch.make`.
 * Mirror of {@link batchV3} for v2-only methods (`task.commentitem.*`,
 * `task.checklistitem.*`, …) — same `{ isHaltOnError: false,
 * returnAjaxResult: true }` semantics, same array-of-`AjaxResult<T>` return
 * type. Bitrix24 caps a v2 batch at 50 commands (per the SDK BatchV2 JSDoc
 * "@warning The maximum number of commands in one batch request is 50.").
 */
export async function batchV2<T>(
  b24: TypeB24,
  calls: BatchCall[],
  errorContext: string,
): Promise<Array<AjaxResult<T>>> {
  let response: CallBatchResult<T>
  try {
    response = await b24.actions.v2.batch.make<T>({
      calls: calls as BatchCommandsArrayUniversal,
      options: { isHaltOnError: false, returnAjaxResult: true },
    })
  } catch (err) {
    throw toToolError(err, errorContext)
  }
  if (!response.isSuccess) {
    throw new Bitrix24ToolError(response.getErrorMessages().join('; ') || errorContext)
  }
  return response.getData() as Array<AjaxResult<T>>
}
