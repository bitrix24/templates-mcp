import { z } from 'zod'
import { useBitrix24Tenant } from '~/server/utils/bitrix24-tenant'
import {
  type ActionToolInput,
  defineActionTool,
  forceFlagSchema,
  idOrIdArraySchema,
  mapBatchRows,
} from '~/server/utils/define-action-tool'
import { Bitrix24ErrorCode, Bitrix24ToolError } from '~/server/utils/errors'
import { batchV2, callV2 } from '~/server/utils/sdk-helpers'

/**
 * Create a dependency between two Bitrix24 tasks. Single or batch.
 *
 * A "dependency" links a predecessor task (`taskIdFrom`) to a dependent
 * task (`taskIdTo`) — the same "Предыдущие задачи" relationship the
 * Bitrix24 task form exposes. The `linkType` encodes the schedule
 * relationship between the predecessor and dependent (start-start,
 * finish-start, …); Bitrix24 itself uses these for Gantt-style
 * scheduling.
 *
 * Bitrix24 REST: task.dependence.add (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/tasks/task-dependence-add.html
 *
 * The brief expected `tasks.task.dependence.add` (v3); a v3 dependence
 * namespace does not exist as of 2026-05. Bitrix24 surfaces
 * dependence-modification through the v2 `task.dependence.*` family
 * only — listed alongside `task.checklistitem.*` / `task.elapseditem.*`
 * in SKILL.md Rule #7's v2-canonical registry.
 *
 * The apidocs error table for `task.dependence.add` lists
 * `ERROR_BATCH_METHOD_NOT_ALLOWED` as a possible error code, which on
 * first read suggests batching might be blocked server-side. In
 * practice this is the generic Bitrix24 batch-rejection error code
 * that appears on every method's error table, NOT a per-endpoint deny
 * list — `task.checklistitem.delete` (PR #31) lists the same error
 * and is batched here without issue. The first pilot smoke-test should
 * still confirm the batch path responds normally on a live portal.
 *
 * Operator path: "сделай так, чтобы задача 100 шла после задач 5, 7, 9" →
 * fix `taskIdTo: 100` + `linkType: 2` (FS), pass `taskIdFrom: [5, 7, 9]`
 * in batch mode. The batch shape mirrors `delete_elapsed_time` — one
 * fixed parent id (`taskIdTo`) plus an id-or-array varying field
 * (`taskIdFrom`). One `linkType` per batch is sufficient for the common
 * pattern; heterogeneous batches (varying `linkType` per pair) would
 * need a different shape and are tracked as #36 (post-pilot revisit).
 *
 * Built atop `defineActionTool` — single-vs-batch dispatch, batch-cap
 * check, and summary projection live in the shared scaffold.
 */

const DEFAULT_BATCH_CAP = 50
const USAGE_NOTES =
  ` Accepts a single \`taskIdFrom\` OR an array of ids (batch mode, up to ${DEFAULT_BATCH_CAP} — pass \`force: true\` to override). All items in a batch share the same \`taskIdTo\` and \`linkType\` (one schedule relationship type per batch). Batch mode goes through one HTTP round-trip and returns a \`{ batch, total, ok, failed, results }\` summary; per-pair errors (e.g. ILLEGAL_NEW_LINK when a link already exists) do not abort the batch.`

interface AddTaskDependencyInput extends ActionToolInput {
  taskIdTo: number
  taskIdFrom: number | number[]
  linkType: number
}

interface AddTaskDependencyBatchRow {
  taskIdFrom: number
  ok: boolean
  error?: string
}

export default defineActionTool<AddTaskDependencyInput, AddTaskDependencyBatchRow>({
  name: 'b24_task_dependency_add',
  description:
    'Create a "previous task" dependency between two Bitrix24 tasks — the dependent task (`taskIdTo`) is scheduled relative to the predecessor (`taskIdFrom`) according to `linkType`. Use this to wire the "Предыдущие задачи" relationship that the Bitrix24 task form exposes (commonly for Gantt-style scheduling). Bitrix24 rejects with ILLEGAL_NEW_LINK if the same `(taskIdFrom, taskIdTo)` pair already has a link, with ACTION_NOT_ALLOWED if the link cannot be created for non-rights reasons (e.g. a scheduling cycle), and with INVALID_CREDENTIALS if the calling user lacks rights on one of the tasks. NOT a delete — does not require `confirmDelete`. To remove a link, use `b24_task_dependency_remove`. There is no read-back tool — Bitrix24 deprecated `task.item.getdependson` server-side with no v3 replacement (verified against a live portal); operators inspect existing dependencies via the Bitrix24 UI.',
  usageNotes: USAGE_NOTES,
  pastTense: 'linked',
  batchCap: DEFAULT_BATCH_CAP,
  inputSchema: {
    taskIdTo: z
      .number()
      .int()
      .positive()
      .describe(
        'The DEPENDENT task — the one whose schedule depends on `taskIdFrom`. In Bitrix24 UI terms, this is the task whose "Предыдущие задачи" field gets the new entry. Fixed for the whole call (single or batch).',
      ),
    taskIdFrom: idOrIdArraySchema.describe(
      'The PREDECESSOR task id (the task the dependent waits on), or an array of predecessor ids for batch mode. Pass a number for single-pair semantics; even a one-element array (e.g. [5]) enters batch mode and returns the batch summary shape — use a plain number when you have exactly one predecessor.',
    ),
    linkType: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe(
        'Schedule relationship between predecessor (`taskIdFrom`) and dependent (`taskIdTo`). One value per call (single OR batch). Choices: 0 = start-start (both tasks start together) | 1 = start-finish (dependent finishes when predecessor starts) | 2 = finish-start (dependent starts when predecessor finishes — the DEFAULT operator intent for "сделай B после A") | 3 = finish-finish (both tasks finish together). When the operator says "после" / "потом" / "вслед за" with no further detail, use 2 (FS).',
      ),
    force: forceFlagSchema(DEFAULT_BATCH_CAP),
  },
  extractIds: (input) => input.taskIdFrom,
  runOne: (input, taskIdFrom) => runOne(input.taskIdTo, taskIdFrom, input.linkType),
  runBatch: (input, ids) => runBatch(input.taskIdTo, ids, input.linkType),
  // Carry `taskIdTo` and `linkType` into the batch summary so the agent
  // sees at a glance what the result rows describe (same idiom as the
  // checklist + elapsed-time factories that pin `taskId`).
  batchSummaryExtras: (input) => ({ taskIdTo: input.taskIdTo, linkType: input.linkType }),
})

/**
 * Refuse self-loops (`taskIdFrom === taskIdTo`) before reaching the wire.
 * Bitrix24 server-side rejects with `ACTION_NOT_ALLOWED`, but that error
 * code is shared with cycle detection and rights failures — an opaque
 * signal the agent might mis-attribute. Surfacing the refusal here gives
 * the LLM a precise reason and avoids the wasted round-trip.
 *
 * For batch mode the offenders are listed so the operator can re-batch
 * without the bad pairs.
 */
function assertNoSelfLoop(taskIdTo: number, taskIdFrom: number | number[]): void {
  const offenders = Array.isArray(taskIdFrom)
    ? taskIdFrom.filter((id) => id === taskIdTo)
    : taskIdFrom === taskIdTo
      ? [taskIdFrom]
      : []
  if (offenders.length === 0) return
  throw new Bitrix24ToolError(
    `Refusing to create a self-loop on task ${taskIdTo} — a task cannot be its own predecessor. `
      + `Offending taskIdFrom ${offenders.length === 1 ? 'value' : 'values'}: ${offenders.join(', ')}. `
      + `Drop the offending id(s) and re-call.`,
    Bitrix24ErrorCode.INVALID_INPUT,
  )
}

async function runOne(taskIdTo: number, taskIdFrom: number, linkType: number) {
  assertNoSelfLoop(taskIdTo, taskIdFrom)
  const b24 = useBitrix24Tenant()
  await callV2<unknown>(
    b24,
    'task.dependence.add',
    { taskIdFrom, taskIdTo, linkType },
    `Failed to link Bitrix24 task ${taskIdTo} to predecessor ${taskIdFrom}`,
  )

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          linked: true,
          taskIdTo,
          taskIdFrom,
          linkType,
        }),
      },
    ],
  }
}

async function runBatch(
  taskIdTo: number,
  taskIdFroms: number[],
  linkType: number,
): Promise<AddTaskDependencyBatchRow[]> {
  assertNoSelfLoop(taskIdTo, taskIdFroms)
  const b24 = useBitrix24Tenant()
  const rows = await batchV2<unknown>(
    b24,
    taskIdFroms.map((from) => ['task.dependence.add', { taskIdFrom: from, taskIdTo, linkType }]),
    `Failed to link a batch of ${taskIdFroms.length} predecessor(s) to Bitrix24 task ${taskIdTo}`,
  )

  return mapBatchRows(rows, taskIdFroms, 'taskIdFrom', ({ id, ok, errorMessages }) => {
    if (!ok) {
      return {
        taskIdFrom: id,
        ok: false,
        error: errorMessages.join('; ') || `Failed to link predecessor ${id} to Bitrix24 task ${taskIdTo}`,
      }
    }
    return { taskIdFrom: id, ok: true }
  })
}
