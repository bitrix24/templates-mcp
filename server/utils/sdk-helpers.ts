import type { AjaxResult, B24Hook } from '@bitrix24/b24jssdk'
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
 */

/**
 * Call a v3 REST method and return its `result` payload.
 *
 * @param b24 — client from `useBitrix24()`.
 * @param method — REST method name (e.g. `tasks.task.start`).
 * @param params — params object (passed straight to `actions.v3.call.make`).
 * @param errorContext — fallback error message when the SDK gives nothing
 *   useful. Reads "Failed to <verb> Bitrix24 task <id>" / similar.
 * @returns The unwrapped `result` payload, or `undefined` if Bitrix24
 *   returned a success envelope with no body (rare; tool handlers should
 *   treat as a defensive branch).
 * @throws {Bitrix24ToolError} on `!isSuccess` or transport failure.
 */
export async function callV3<T>(
  b24: B24Hook,
  method: string,
  params: Record<string, unknown>,
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
 * Accepts either an object-shaped `params` (the common case) or a positional
 * array (some v2 methods are documented with positional args only — e.g.
 * `task.checklistitem.{complete,renew}` per
 * https://apidocs.bitrix24.ru/api-reference/tasks/checklist-item/). The
 * underlying SDK serialiser honours both shapes; we widen the type here so
 * callers do not need to cast at every call site.
 */
export async function callV2<T>(
  b24: B24Hook,
  method: string,
  params: Record<string, unknown> | unknown[],
  errorContext: string,
): Promise<T | undefined> {
  let response: AjaxResult<T>
  try {
    response = await b24.actions.v2.call.make<T>({
      method,
      params: params as unknown as Parameters<typeof b24.actions.v2.call.make>[0]['params'],
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
 * One v3 batch call shape: a tuple of REST method name + params object.
 * Matches the array form of `BatchCommandsArrayUniversal` from the SDK.
 *
 * Bitrix24's batch transport accepts both an object-shaped params and a
 * positional array (`[a, b]`) — some v2 endpoints, notably
 * `task.checklistitem.{complete,renew}`, are documented with positional
 * params only. The runtime serialiser handles both shapes; we widen the
 * tuple's second element to `Record | unknown[]` so callers can pass either
 * without casting at the call site.
 */
export type BatchV3Call = [method: string, params: Record<string, unknown> | unknown[]]

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
  b24: B24Hook,
  calls: BatchV3Call[],
  errorContext: string,
): Promise<Array<AjaxResult<T>>> {
  let response
  try {
    response = await b24.actions.v3.batch.make<T>({
      calls: calls as unknown as Parameters<typeof b24.actions.v3.batch.make>[0]['calls'],
      options: { isHaltOnError: false, returnAjaxResult: true },
    })
  } catch (err) {
    throw toToolError(err, errorContext)
  }
  if (!response.isSuccess) {
    throw new Bitrix24ToolError(response.getErrorMessages().join('; ') || errorContext)
  }
  // SDK behaviour with `returnAjaxResult: true` is documented in the SDK's
  // own `batch.make` example — the bare-payload return type is replaced by
  // an array of full `AjaxResult<T>` rows. The cast localises that single
  // type-system gap so callers see a clean `AjaxResult<T>[]`.
  return response.getData() as unknown as Array<AjaxResult<T>>
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
  b24: B24Hook,
  calls: BatchV3Call[],
  errorContext: string,
): Promise<Array<AjaxResult<T>>> {
  let response
  try {
    response = await b24.actions.v2.batch.make<T>({
      calls: calls as unknown as Parameters<typeof b24.actions.v2.batch.make>[0]['calls'],
      options: { isHaltOnError: false, returnAjaxResult: true },
    })
  } catch (err) {
    throw toToolError(err, errorContext)
  }
  if (!response.isSuccess) {
    throw new Bitrix24ToolError(response.getErrorMessages().join('; ') || errorContext)
  }
  return response.getData() as unknown as Array<AjaxResult<T>>
}
