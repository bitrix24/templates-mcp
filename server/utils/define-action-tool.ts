import { z } from 'zod'
import { defineMcpTool } from '@nuxtjs/mcp-toolkit/server'
import type { AjaxResult } from '@bitrix24/b24jssdk'
import { Bitrix24ErrorCode, Bitrix24ToolError } from '~/server/utils/errors'

/**
 * Generic single-or-batch action factory used by every action-tool family.
 *
 * Current consumers:
 *   - `server/utils/task-lifecycle.ts` — 7 v3 lifecycle wrappers (`start`,
 *     `pause`, `complete`, `approve`, `disapprove`, `defer`, `renew`)
 *   - `server/utils/checklist.ts` — 3 v2 checklist action wrappers
 *     (`complete`, `renew`, `delete`), with optional heading-delete
 *     pre-flight
 *   - `server/mcp/tools/tasks/delete-elapsed-time.ts` — v2 delete with
 *     universal `confirmDelete` gate (Ground Rule #9)
 *   - `server/mcp/tools/tasks/add-task-dependency.ts` — v2 add with
 *     fixed `taskIdTo` + `linkType` and id-or-array `taskIdFrom`
 *   - `server/mcp/tools/tasks/remove-task-dependency.ts` — v2 delete
 *     mirror of add; uses the universal `confirmDelete` gate
 *
 * All families share:
 *   1. The same input shape — a target id that's either a number
 *      (single-mode) or an array of ids (batch-mode), plus a `force` flag
 *      to override the batch cap.
 *   2. The same dispatch contract — single mode calls the action once;
 *      batch mode dispatches a single round-trip and returns a per-id
 *      summary `{ batch, verb, total, ok, failed, results }`.
 *   3. The same `BATCH_TOO_LARGE` error semantics.
 *
 * What differs per family lives in the spec callbacks (REST version, wire
 * params shape, response projection, optional pre-flight, confirm gates).
 * Each wrapper stays small and domain-focused while this file owns the
 * single-vs-batch dispatch + summary projection that used to drift
 * between families.
 *
 * Adding a new action-tool family means writing the runOne / runBatch
 * callbacks — the scaffold stays here.
 */

/**
 * Shared schema fragment for an "id-or-array-of-ids" input. All action-tool
 * families use exactly this — a positive int (single mode) OR a non-empty
 * array of positive ints (batch mode).
 */
export const idOrIdArraySchema = z.union([
  z.number().int().positive(),
  z.array(z.number().int().positive()).min(1),
])

/**
 * Generic per-row result shape returned by `runBatch`.
 *
 * Domain-specific fields (`taskId`, `itemId`, `status`, …) live in the rest
 * of the object — `TBatchRow` widens this with whatever the caller needs.
 * `ok` discriminates success vs failure; `error` carries the SDK's joined
 * message on failure (omitted on success).
 *
 * Callers are not required to declare `extends BatchRow` literally — TS
 * structural compatibility is enough as long as the projection callback
 * produces `{ ok: boolean, error?: string, ... }`. The factory only reads
 * `ok` to count `total/ok/failed` for the batch summary envelope.
 */
export interface BatchRow {
  ok: boolean
  error?: string
}

/**
 * Standard `force` flag schema for batch-cap overrides. Every factory
 * family wires this verbatim — keeping the LLM-facing copy in one place
 * prevents drift between tools.
 *
 * @param cap — the batch cap the description should mention, so the LLM
 *   sees the family-specific number (e.g. 25 for v3 lifecycle, 50 for v2
 *   checklist / elapsed-time) rather than a generic blurb.
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
 * Shared schema fragment for the universal `confirmDelete` gate, mandated
 * by SKILL.md Ground Rule #9 — every delete tool MUST require an explicit
 * confirmation before proceeding. Single or batch, cascade or not.
 *
 * The handler is responsible for the actual refusal — read
 * `input.confirmDelete` and throw a {@link Bitrix24ToolError} with code
 * `DELETE_NEEDS_CONFIRM` if it's not `true`. The schema-level optional is
 * deliberate: the field defaults to `undefined`, the handler raises a
 * typed error, and the agent gets a clear "re-call with confirmDelete:
 * true" path instead of a generic Zod failure.
 *
 * Cascade-destructive deletes (e.g. checklist heading delete) layer a
 * second confirm field (e.g. `confirmDeleteHeading`) per Ground Rule #10 —
 * the agent must set BOTH to true.
 */
export function confirmDeleteSchema() {
  return z
    .boolean()
    .optional()
    .describe(
      'REQUIRED for every delete operation (SKILL.md Ground Rule #9). The agent MUST receive explicit operator agreement BEFORE setting this — "да, удали" is consent, "посмотри" / "проверь" / "найди" are NOT. Auto-confirming without operator agreement (e.g. setting `true` reflexively, or because the agent thinks it knows the operator intent) defeats the gate and counts as a Rule #9 violation. The tool refuses with DELETE_NEEDS_CONFIRM if absent or `false`. Applies to BOTH single and batch — the confirm is per-call, not per-id; for batches, the operator must have agreed to the WHOLE batch (e.g. "удали записи 5, 7, 9" — three ids named aloud and confirmed). For cascade-destructive deletes (e.g. checklist heading), a second `confirm<Cascade>` field stacks on top.',
    )
}

/**
 * Universal Rule #9 gate — refuse a delete that wasn't explicitly confirmed.
 *
 * Single shared implementation for every `*_delete` / `*_remove` tool. Each
 * callsite formats its own `targetDescription` (e.g. `"elapsed-time entry 5
 * on task 1"` or `"3 checklist item(s) [475, 433] on task 13"`) so the LLM
 * sees a domain-specific message naming exactly what would be wiped. The
 * `toolName` interpolates into the `Re-call \`...\`` instruction.
 *
 * Behaviour pinned by existing tests across consumers — the message shape
 * is `Refusing to delete <target> without confirmation. Re-call \`<toolName>\`
 * with \`confirmDelete: true\` only after the operator has explicitly agreed
 * to the deletion (SKILL.md Ground Rule #9).`. Code is always
 * `DELETE_NEEDS_CONFIRM`.
 *
 * Consumers must call this BEFORE any pre-flight round-trip (e.g. the
 * checklist heading-detection `getlist`) so an unconfirmed call
 * short-circuits without spending a wire call.
 *
 * Closes #32 — previously duplicated as module-local functions in
 * `delete-elapsed-time.ts` + `checklist.ts`, and inline in
 * `delete-task-result.ts` (3 existing callsites). PR-C adds a 4th
 * (`remove-task-dependency.ts`); the consolidation lives here so the
 * 4th callsite lands on the shared helper rather than proliferating a
 * fourth copy.
 */
export function assertConfirmedDelete(
  toolName: string,
  targetDescription: string,
  confirmed: boolean | undefined,
): void {
  if (confirmed) return
  throw new Bitrix24ToolError(
    `Refusing to delete ${targetDescription} without confirmation. Re-call \`${toolName}\` with \`confirmDelete: true\` only after the operator has explicitly agreed to the deletion (SKILL.md Ground Rule #9).`,
    Bitrix24ErrorCode.DELETE_NEEDS_CONFIRM,
  )
}

/**
 * Shape every {@link defineActionTool} caller must satisfy on its input
 * type. Two constraints:
 *
 *   1. `force?: boolean` — read by the factory itself (batch-cap override),
 *      so the type system carries the obligation that every caller's input
 *      includes the flag even if Zod-schema authors forget to declare it.
 *      Adding a new family without `force` would be a regression: Bitrix24
 *      batch caps could not be overridden by the agent, and the type error
 *      here surfaces that immediately instead of at runtime.
 *
 *   2. `extends Record<string, unknown>` — required because the factory's
 *      handler boundary widens `ShapeOutput<ZodRawShape>` to
 *      `Record<string, unknown>` (mcp-toolkit's generic loses the specific
 *      shape at the `spec.inputSchema: z.ZodRawShape` seam). The constraint
 *      lets the localised `as unknown as TInput` cast inside the handler
 *      stay sound — TInput is structurally assignable from the broad
 *      `Record<string, unknown>` Zod produces post-validation.
 */
export interface ActionToolInput extends Record<string, unknown> {
  force?: boolean
}

/**
 * Spec consumed by {@link defineActionTool}.
 *
 * @template TInput — full handler input shape, narrowed by the caller's
 *   Zod schema. Must include `force?: boolean` (enforced by extending
 *   {@link ActionToolInput}) so the factory's batch-cap override stays
 *   wired across every family.
 * @template TBatchRow — per-id row shape returned by `runBatch`. Must
 *   extend {@link BatchRow} so the summary can count `ok` / `failed`.
 */
export interface ActionToolSpec<TInput extends ActionToolInput, TBatchRow extends BatchRow> {
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

export function defineActionTool<TInput extends ActionToolInput, TBatchRow extends BatchRow>(
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
    // localised; Zod has already validated the wire shape against
    // `spec.inputSchema` upstream in mcp-toolkit before reaching `handler`.
    handler: async (rawInput) => {
      const input = rawInput as unknown as TInput
      const target = spec.extractIds(input)
      if (typeof target === 'number') {
        return spec.runOne(input, target)
      }
      // `force` typed on `ActionToolInput` so every TInput carries it —
      // no defensive cast needed. Zod will reject non-boolean values at
      // the wire boundary.
      const force = Boolean(input.force)
      if (target.length > spec.batchCap && !force) {
        throw new Bitrix24ToolError(
          `Batch of ${target.length} exceeds the default cap of ${spec.batchCap}. Pass force=true to override, or split into multiple calls.`,
          Bitrix24ErrorCode.BATCH_TOO_LARGE,
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
 * Two-sided length guard: the SDK's `returnAjaxResult: true` contract
 * promises `rows.length === ids.length`. If the SDK ever drifts in either
 * direction — extra rows OR missing rows — we'd silently emit malformed
 * results (the per-row defensive `id === undefined` throw only catches
 * extra rows; missing rows would just truncate the output). An explicit
 * upfront length assert catches both at the seam and fails loud.
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
  if (rows.length !== ids.length) {
    throw new Bitrix24ToolError(
      `SDK rows/input length mismatch: ${rows.length} rows for ${ids.length} ${defensiveLabel} entries. `
        + `The SDK's returnAjaxResult contract guarantees alignment — this indicates a contract drift.`,
    )
  }
  return rows.map((row, index) => {
    // After the upfront length check, `ids[index]` is provably defined,
    // but TS's `noUncheckedIndexedAccess` widens the type. The fallback
    // throw is for the type system; the runtime path is unreachable.
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
