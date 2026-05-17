import { AjaxError, SdkError } from '@bitrix24/b24jssdk'

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
 */
export class Bitrix24ToolError extends Error {
  override readonly name = 'Bitrix24ToolError'
  readonly code: string
  readonly status: number | undefined

  constructor(message: string, code = 'BITRIX24_ERROR', status?: number) {
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
    const code = (err as { code?: string }).code ?? 'BITRIX24_ERROR'
    return new Bitrix24ToolError(err.message || fallback, code)
  }

  return new Bitrix24ToolError(fallback)
}
