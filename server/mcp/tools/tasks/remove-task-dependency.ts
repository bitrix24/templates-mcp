import { z } from 'zod'
import { useBitrix24 } from '~/server/utils/bitrix24'
import {
  type ActionToolInput,
  assertConfirmedDelete,
  confirmDeleteSchema,
  defineActionTool,
  forceFlagSchema,
  idOrIdArraySchema,
  mapBatchRows,
} from '~/server/utils/define-action-tool'
import { batchV2, callV2 } from '~/server/utils/sdk-helpers'

/**
 * Remove a dependency between two Bitrix24 tasks. Single or batch.
 *
 * Mirror of `add_task_dependency` — same `(taskIdFrom, taskIdTo)` pair
 * keying, only the wire endpoint differs. `linkType` is NOT a parameter
 * for delete (Bitrix24 keys the link only by the task pair; there can
 * be only one link per pair).
 *
 * Bitrix24 REST: task.dependence.delete (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/tasks/task-dependence-delete.html
 *
 * Universal `confirmDelete` gate per SKILL.md Ground Rule #9 — the tool
 * refuses with DELETE_NEEDS_CONFIRM unless the agent set the flag
 * explicitly after operator agreement. Per Rule #10 we do NOT layer a
 * cascade gate: removing a dependency edge does not silently destroy
 * anything beyond the named link — it just removes one row from the
 * predecessor table. No pre-flight is needed.
 *
 * Bitrix24 returns ILLEGAL_NEW_LINK when the named link does not exist
 * (slightly confusing reuse of the same code as add-time "already
 * exists"); the per-row error message preserves the SDK's wording so
 * the agent can disambiguate.
 *
 * Built atop `defineActionTool` — single-vs-batch dispatch, batch-cap
 * check, and summary projection live in the shared scaffold.
 */

const DEFAULT_BATCH_CAP = 50
const USAGE_NOTES =
  ` Accepts a single \`taskIdFrom\` OR an array of ids (batch mode, up to ${DEFAULT_BATCH_CAP} — pass \`force: true\` to override). All items in a batch share the same \`taskIdTo\`. Batch mode goes through one HTTP round-trip and returns a \`{ batch, total, ok, failed, results }\` summary; per-pair errors (e.g. ILLEGAL_NEW_LINK when a link doesn't exist) do not abort the batch.`

interface RemoveTaskDependencyInput extends ActionToolInput {
  taskIdTo: number
  taskIdFrom: number | number[]
  confirmDelete?: boolean
}

interface RemoveTaskDependencyBatchRow {
  taskIdFrom: number
  ok: boolean
  error?: string
}

export default defineActionTool<RemoveTaskDependencyInput, RemoveTaskDependencyBatchRow>({
  name: 'b24_task_dependency_remove',
  description:
    'Remove a "previous task" dependency between two Bitrix24 tasks — wipes the predecessor link from `taskIdFrom` to `taskIdTo`. REQUIRES `confirmDelete: true` (SKILL.md Ground Rule #9, universal) after the operator has explicitly agreed to the removal. Bitrix24 rejects with ILLEGAL_NEW_LINK if the link does not exist (same code as "already exists" on add — disambiguate by reading the error message). To CREATE a link, use `b24_task_dependency_add`. There is no read-back tool — Bitrix24 deprecated `task.item.getdependson` server-side with no v3 replacement (verified against a live portal); operators inspect existing dependencies via the Bitrix24 UI.',
  usageNotes: USAGE_NOTES,
  pastTense: 'unlinked',
  batchCap: DEFAULT_BATCH_CAP,
  inputSchema: {
    taskIdTo: z
      .number()
      .int()
      .positive()
      .describe(
        'The DEPENDENT task — the one whose "Предыдущие задачи" field has the entry to remove. Fixed for the whole call (single or batch).',
      ),
    taskIdFrom: idOrIdArraySchema.describe(
      'The PREDECESSOR task id to unlink (the task the dependent currently waits on), or an array of predecessor ids for batch mode. Pass a number for single-pair semantics; even a one-element array (e.g. [5]) enters batch mode and returns the batch summary shape — use a plain number when you have exactly one predecessor.',
    ),
    confirmDelete: confirmDeleteSchema(),
    force: forceFlagSchema(DEFAULT_BATCH_CAP),
  },
  extractIds: (input) => input.taskIdFrom,
  runOne: (input, taskIdFrom) => runOne(input.taskIdTo, taskIdFrom, input.confirmDelete ?? false),
  runBatch: (input, ids) => runBatch(input.taskIdTo, ids, input.confirmDelete ?? false),
  batchSummaryExtras: (input) => ({ taskIdTo: input.taskIdTo }),
})

function describeTarget(taskIdTo: number, taskIdFrom: number | number[]): string {
  return Array.isArray(taskIdFrom)
    ? `${taskIdFrom.length} dependency link(s) [${taskIdFrom.join(', ')}] → task ${taskIdTo}`
    : `dependency link ${taskIdFrom} → task ${taskIdTo}`
}

async function runOne(taskIdTo: number, taskIdFrom: number, confirmDelete: boolean) {
  assertConfirmedDelete('b24_task_dependency_remove', describeTarget(taskIdTo, taskIdFrom), confirmDelete)
  const b24 = useBitrix24()
  await callV2<unknown>(
    b24,
    'task.dependence.delete',
    { taskIdFrom, taskIdTo },
    `Failed to unlink Bitrix24 task ${taskIdTo} from predecessor ${taskIdFrom}`,
  )

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          unlinked: true,
          taskIdTo,
          taskIdFrom,
        }),
      },
    ],
  }
}

async function runBatch(
  taskIdTo: number,
  taskIdFroms: number[],
  confirmDelete: boolean,
): Promise<RemoveTaskDependencyBatchRow[]> {
  assertConfirmedDelete('b24_task_dependency_remove', describeTarget(taskIdTo, taskIdFroms), confirmDelete)
  const b24 = useBitrix24()
  const rows = await batchV2<unknown>(
    b24,
    taskIdFroms.map((from) => ['task.dependence.delete', { taskIdFrom: from, taskIdTo }]),
    `Failed to unlink a batch of ${taskIdFroms.length} predecessor(s) from Bitrix24 task ${taskIdTo}`,
  )

  return mapBatchRows(rows, taskIdFroms, 'taskIdFrom', ({ id, ok, errorMessages }) => {
    if (!ok) {
      return {
        taskIdFrom: id,
        ok: false,
        error: errorMessages.join('; ') || `Failed to unlink predecessor ${id} from Bitrix24 task ${taskIdTo}`,
      }
    }
    return { taskIdFrom: id, ok: true }
  })
}
