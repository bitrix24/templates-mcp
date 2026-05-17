import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { AjaxResult } from '@bitrix24/b24jssdk'
import { Bitrix24ToolError } from '~/server/utils/errors'

/**
 * Generic single-or-batch action factory shared by the `tasks.task.*`
 * lifecycle wrappers (`start`, `pause`, …) and the `task.checklistitem.*`
 * action wrappers (`complete`, `renew`, `delete`).
 *
 * Both families share:
 *   1. The same input shape — a target id that's either a number
 *      (single-mode) or an array of ids (batch-mode), plus a `force` flag
 *      to override the batch cap.
 *   2. The same dispatch contract — single mode calls the action once;
 *      batch mode dispatches a single round-trip and returns a per-id
 *      summary `{ batch, verb, total, ok, failed, results }`.
 *   3. The same `BATCH_TOO_LARGE` error semantics.
 *
 * What differs per family lives in the spec callbacks (REST version, wire
 * params shape, response projection, optional pre-flight). Each wrapper
 * factory stays small and domain-focused while this file owns the
 * single-vs-batch dispatch + summary projection that used to drift
 * between them.
 *
 * Adding a new action-tool family (e.g. `task.dependence.*` in Phase 2)
 * means writing the runOne / runBatch callbacks — the scaffold stays here.
 */

/**
 * Shared schema fragment for an "id-or-array-of-ids" input. Both factory
 * families use exactly this — a positive int (single mode) OR a non-empty
 * array of positive ints (batch mode).
 */
export const idOrIdArraySchema = z.union([
  z.number().int().positive(),
  z.array(z.number().int().positive()).min(1),
])

/** Generic per-row result shape returned by `runBatch`. Domain-specific
 *  fields (`taskId`, `itemId`, `status`, …) live in the rest of the
 *  object; `ok` discriminates success vs failure, and `error` is the SDK
 *  joined message on failure. */
export interface BatchRow {
  ok: boolean
  error?: string
}

/**
 * Build the standard `force` flag schema. Lives here so the description
 * stays identical across both factories — drift in the LLM-facing copy
 * would dilute the contract.
 */
export function forceFlagSchema(cap: number) {
  return z
    .boolean()
    .optional()
    .describe(
      `Set true to allow batches larger than ${cap}. Use sparingly — MCP clients may time out on long-running tool calls. Ignored for single-id input.`,
    )
}

/**
 * Spec consumed by {@link defineActionTool}.
 *
 * @template TInput — full handler input shape, narrowed by the caller's
 *   Zod schema. The factory does not inspect specific fields beyond
 *   reading `force` from `(input as { force?: boolean })`.
 * @template TBatchRow — per-id row shape returned by `runBatch`. Must
 *   extend {@link BatchRow} so the summary can count `ok` / `failed`.
 */
export interface ActionToolSpec<TInput extends Record<string, unknown>, TBatchRow extends BatchRow> {
  name: string
  /** Human-readable tool description for the LLM. `usageNotes` are appended automatically. */
  description: string
  /** Universal usage notes appended to `description`. Identical across a family of tools, so callers concatenate once via the factory. */
  usageNotes: string
  /** Past-tense verb used in the summary envelope and the single-success body, e.g. `started`. */
  pastTense: string
  /** Zod input schema (raw shape). Must include the id field and `force`. The factory does NOT auto-inject anything. */
  inputSchema: z.ZodRawShape
  /** Default batch cap. The factory throws `BATCH_TOO_LARGE` above this unless `force: true`. */
  batchCap: number
  /**
   * Extract the id-or-array from the input. Returning a `number` triggers
   * single-mode dispatch (`runOne`); returning a `number[]` triggers batch
   * dispatch (`runBatch`).
   */
  extractIds: (input: TInput) => number | number[]
  /** Run the single-id action. Returns the complete tool envelope (the
   *  factory does NOT wrap it further). Returning the full envelope lets
   *  callsites choose JSON vs plaintext for edge cases like
   *  "Bitrix24 returned no body". */
  runOne: (input: TInput, id: number) => Promise<{ content: { type: 'text'; text: string }[] }>
  /** Run the batch action. Must return one row per input id, in input order. */
  runBatch: (input: TInput, ids: number[]) => Promise<TBatchRow[]>
  /**
   * Optional extra fields injected into the batch summary envelope. The
   * checklist factory uses this for `{ taskId }`; the lifecycle factory
   * leaves it unset.
   */
  batchSummaryExtras?: (input: TInput, ids: number[]) => Record<string, unknown>
}

export function defineActionTool<TInput extends Record<string, unknown>, TBatchRow extends BatchRow>(
  spec: ActionToolSpec<TInput, TBatchRow>,
) {
  return defineMcpTool({
    name: spec.name,
    description: spec.description + spec.usageNotes,
    inputSchema: spec.inputSchema,
    // The mcp-toolkit handler infers `args` from `inputSchema` via Zod's
    // ShapeOutput. Because the schema reaches us through a generic
    // `ZodRawShape`, that inference widens to `Record<string, unknown>` —
    // the typed `TInput` shape is lost at this boundary. We cast once,
    // localised, after Zod has already validated the wire shape against
    // `spec.inputSchema`.
    handler: async (rawInput) => {
      const input = rawInput as unknown as TInput
      const target = spec.extractIds(input)
      if (typeof target === 'number') {
        return spec.runOne(input, target)
      }
      // Read `force` defensively — every caller follows this convention but
      // the factory doesn't enforce it in the schema (each family declares
      // its own `force` so the description can mention the family-specific
      // cap).
      const force = Boolean((input as { force?: boolean }).force)
      if (target.length > spec.batchCap && !force) {
        throw new Bitrix24ToolError(
          `Batch of ${target.length} exceeds the default cap of ${spec.batchCap}. Pass force=true to override, or split into multiple calls.`,
          'BATCH_TOO_LARGE',
        )
      }
      const rows = await spec.runBatch(input, target)
      const ok = rows.filter((r) => r.ok).length
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              batch: true,
              verb: spec.pastTense,
              ...(spec.batchSummaryExtras?.(input, target) ?? {}),
              total: rows.length,
              ok,
              failed: rows.length - ok,
              results: rows,
            }),
          },
        ],
      }
    },
  })
}

/**
 * Walk SDK batch rows in lockstep with the input ids, building one
 * `BatchRow` per row via the caller's projection.
 *
 * The defensive `id === undefined` throw guards against an SDK contract
 * drift where `rows.length !== ids.length`. `returnAjaxResult: true`
 * currently guarantees alignment but a future SDK release could change
 * this — failing loud is preferable to silently emitting entries with
 * `taskId: undefined`.
 *
 * Both factory families used to inline this loop with subtle drift. One
 * helper means one place to audit the alignment contract.
 */
export function mapBatchRows<TEnvelope, TRow extends BatchRow>(
  rows: Array<AjaxResult<TEnvelope>>,
  ids: number[],
  defensiveLabel: string,
  build: (ctx: { id: number; ok: boolean; envelope: TEnvelope | undefined; errorMessages: string[] }) => TRow,
): TRow[] {
  return rows.map((row, index) => {
    const id = ids[index]
    if (id === undefined) {
      throw new Bitrix24ToolError(
        `Batch row index ${index} has no corresponding ${defensiveLabel}; SDK rows/input length mismatch.`,
      )
    }
    if (row.isSuccess) {
      return build({ id, ok: true, envelope: row.getData()?.result, errorMessages: [] })
    }
    return build({ id, ok: false, envelope: undefined, errorMessages: row.getErrorMessages() })
  })
}
