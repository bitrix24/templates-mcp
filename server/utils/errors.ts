import { AjaxError, SdkError } from '@bitrix24/b24jssdk'

/**
 * Registry of project-defined error codes thrown by tool handlers and shared
 * utilities. Use these constants instead of raw string literals so typos
 * become compile errors and the catalogue stays discoverable in one place.
 *
 * **This is not exhaustive** — `Bitrix24ToolError.code` is intentionally
 * typed `Bitrix24ErrorCode | string` to allow Bitrix24's own REST error
 * codes (`QUERY_LIMIT_EXCEEDED`, `ACCESS_DENIED`, `OPERATION_TIME_LIMIT`,
 * `BITRIX_REST_V3_EXCEPTION_*`, …) to pass through `toToolError` unchanged.
 * Listing all 100+ SDK codes would be churn without benefit; the registry
 * captures only the codes _we_ generate, where typo protection matters.
 *
 * Adding a new code: append a `KEY: 'VALUE'` line below, then reference it
 * as `Bitrix24ErrorCode.KEY` at the throw site and in test assertions.
 * See `skills/manage-bx24-template-mcp/adding-tools.md`, section "Errors and
 * logging".
 */
export const Bitrix24ErrorCode = {
  /** Default code: SDK-passed errors without a `.code` field AND
   *  project-side `new Bitrix24ToolError(msg)` without an explicit code. */
  BITRIX24_ERROR: 'BITRIX24_ERROR',
  /** Batch input exceeded a tool's `batchCap`; the operator must split or pass `force=true`. */
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  /** Destructive operation called without `confirmDelete: true` (SKILL.md Ground Rule #9). */
  DELETE_NEEDS_CONFIRM: 'DELETE_NEEDS_CONFIRM',
  /** Checklist heading delete called without `confirmDeleteHeading: true` (SKILL.md Ground Rule #10). */
  HEADING_DELETE_NEEDS_CONFIRM: 'HEADING_DELETE_NEEDS_CONFIRM',
  /** Update tool called with no field changes — all fields `undefined`. */
  NO_CHANGES: 'NO_CHANGES',
  /** Schema-passing but semantically invalid input (self-loop, out-of-range id, …). */
  INVALID_INPUT: 'INVALID_INPUT',
} as const

export type Bitrix24ErrorCode = typeof Bitrix24ErrorCode[keyof typeof Bitrix24ErrorCode]

/**
 * Bitrix24 SDK errors carry a `.message` and sometimes a `.code` describing the
 * REST error. We rethrow them as structured Errors so MCP tool handlers can
 * surface meaningful messages to the AI agent without leaking internals like
 * webhook URLs or stack traces.
 *
 * `status` is always present on the instance (declared with definite type
 * `number | undefined`, not optional `status?`) so consumers can iterate the
 * shape without a hasOwn check. `undefined` means "the upstream error didn't
 * carry an HTTP status" — typically a transport-level / config error.
 *
 * `code` is typed `Bitrix24ErrorCode | string` — pass a registry constant
 * (`Bitrix24ErrorCode.X`) for codes we generate; leave the `string` escape
 * hatch for SDK-passed codes funnelled through {@link toToolError}.
 */
export class Bitrix24ToolError extends Error {
  override readonly name = 'Bitrix24ToolError'
  readonly code: Bitrix24ErrorCode | string
  readonly status: number | undefined

  constructor(message: string, code: Bitrix24ErrorCode | string = Bitrix24ErrorCode.BITRIX24_ERROR, status?: number) {
    super(message)
    this.code = code
    // Assigned unconditionally so the property exists on every instance;
    // a missing status from the caller lands as `undefined` (not "absent").
    this.status = status
  }
}

export function toToolError(err: unknown, fallback = 'Bitrix24 request failed'): Bitrix24ToolError {
  if (err instanceof Bitrix24ToolError) return err

  // `AjaxError` (REST-level failure) and the broader `SdkError` (auth / config /
  // transport) both carry a typed `.code` from the SDK. Prefer them over a
  // generic Error so the LLM sees the actual Bitrix24 error code.
  if (err instanceof AjaxError) {
    return new Bitrix24ToolError(err.message || fallback, err.code, err.status)
  }
  if (err instanceof SdkError) {
    return new Bitrix24ToolError(err.message || fallback, err.code, err.status)
  }

  if (err instanceof Error) {
    // Back-compat: callers (and SDK internals before AjaxError was introduced)
    // sometimes attach a `.code` property to a plain Error. Lift it so the
    // agent sees the upstream code even without an SDK-typed error class.
    const code = (err as { code?: string }).code ?? Bitrix24ErrorCode.BITRIX24_ERROR
    return new Bitrix24ToolError(err.message || fallback, code)
  }

  return new Bitrix24ToolError(fallback)
}
