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
 * Delete an elapsed-time entry on a Bitrix24 task. Single or batch.
 *
 * Common operator path: "удали миссклики 5, 7, 9 на этой задаче" —
 * stopwatch / manual entries sometimes pile up after a botched UI session,
 * and batching the cleanup saves N round-trips.
 *
 * Bitrix24 REST: task.elapseditem.delete (v2 — no v3 equivalent)
 *   https://apidocs.bitrix24.com/api-reference/tasks/elapsed-item/task-elapsed-item-delete.html
 *
 * Returns `null` on success per Bitrix24 v2 contract — the per-row body in
 * batch mode is just `{ itemId, ok }`. Author / responsible-user / admin
 * scope: Bitrix24 enforces server-side. A pre-flight `user.current` +
 * author-id comparison is planned per issue #24 — until then non-author
 * deletes surface as ACCESS_DENIED late in the round-trip.
 *
 * Universal `confirmDelete` gate per SKILL.md Ground Rule #9 — the tool
 * refuses with DELETE_NEEDS_CONFIRM unless the agent set it explicitly.
 * Wiping a team's recorded time-log with one batch call is a serious
 * action; the confirm step is a cheap hold-back that catches LLM
 * mis-interpretation of "посмотри" as "удали".
 *
 * Built atop `defineActionTool` — the single-vs-batch dispatch, batch-cap
 * check, and summary projection are shared across all action-tool families
 * (lifecycle, checklist, elapsed-time, …) via that scaffold.
 */

const DEFAULT_BATCH_CAP = 50
const USAGE_NOTES =
  ` Accepts a single entry id OR an array of ids (batch mode, up to ${DEFAULT_BATCH_CAP} — pass \`force: true\` to override). Batch mode goes through one HTTP round-trip and returns a \`{ batch, total, ok, failed, results }\` summary; per-id errors do not abort the batch. If the operator names entries in free text, list the entries first via \`b24_task_elapsed_time_list\` and match by commentText / seconds / dateStart.`

interface DeleteElapsedTimeInput extends ActionToolInput {
  taskId: number
  itemId: number | number[]
  confirmDelete?: boolean
}

interface DeleteElapsedTimeBatchRow {
  itemId: number
  ok: boolean
  error?: string
}

export default defineActionTool<DeleteElapsedTimeInput, DeleteElapsedTimeBatchRow>({
  name: 'b24_task_elapsed_time_delete',
  description:
    'Delete elapsed-time entries on a Bitrix24 task. Use for cleanup of duplicate / miss-clicked entries, or to remove a stopwatch session that ended up not counting. REQUIRES `confirmDelete: true` (SKILL.md Ground Rule #9 — every delete needs explicit operator agreement). Only the entry author (or someone with admin rights) can delete. To CORRECT an entry instead of removing it, use `b24_task_elapsed_time_update`.',
  usageNotes: USAGE_NOTES,
  pastTense: 'deleted',
  batchCap: DEFAULT_BATCH_CAP,
  inputSchema: {
    taskId: z.number().int().positive().describe('Task id the entries belong to.'),
    itemId: idOrIdArraySchema.describe(
      'Elapsed-time entry id (from `b24_task_elapsed_time_list`), or an array of ids for batch mode. Pass a number for single-entry semantics; even a one-element array (e.g. [42]) enters batch mode and returns the batch summary shape — use a plain number when you have exactly one id.',
    ),
    confirmDelete: confirmDeleteSchema(),
    force: forceFlagSchema(DEFAULT_BATCH_CAP),
  },
  extractIds: (input) => input.itemId,
  runOne: (input, itemId) => runOne(input.taskId, itemId, input.confirmDelete ?? false),
  runBatch: (input, ids) => runBatch(input.taskId, ids, input.confirmDelete ?? false),
  // Carry `taskId` into the batch summary so the agent sees at a glance
  // which task the result rows belong to — same idiom as the checklist
  // factory.
  batchSummaryExtras: (input) => ({ taskId: input.taskId }),
})

function describeTarget(taskId: number, itemId: number | number[]): string {
  return Array.isArray(itemId)
    ? `${itemId.length} elapsed-time entries [${itemId.join(', ')}] on task ${taskId}`
    : `elapsed-time entry ${itemId} on task ${taskId}`
}

async function runOne(taskId: number, itemId: number, confirmDelete: boolean) {
  assertConfirmedDelete('b24_task_elapsed_time_delete', describeTarget(taskId, itemId), confirmDelete)
  const b24 = useBitrix24()
  await callV2<null>(
    b24,
    'task.elapseditem.delete',
    { TASKID: taskId, ITEMID: itemId },
    `Failed to delete Bitrix24 elapsed-time entry ${itemId} on task ${taskId}`,
  )

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          deleted: true,
          taskId,
          itemId,
        }),
      },
    ],
  }
}

async function runBatch(
  taskId: number,
  itemIds: number[],
  confirmDelete: boolean,
): Promise<DeleteElapsedTimeBatchRow[]> {
  assertConfirmedDelete('b24_task_elapsed_time_delete', describeTarget(taskId, itemIds), confirmDelete)
  const b24 = useBitrix24()
  const rows = await batchV2<null>(
    b24,
    itemIds.map((id) => ['task.elapseditem.delete', { TASKID: taskId, ITEMID: id }]),
    `Failed to delete a batch of ${itemIds.length} elapsed-time entry(s) on task ${taskId}`,
  )

  return mapBatchRows(rows, itemIds, 'itemId', ({ id, ok, errorMessages }) => {
    if (!ok) {
      return {
        itemId: id,
        ok: false,
        error: errorMessages.join('; ') || `Failed to delete Bitrix24 elapsed-time entry ${id} on task ${taskId}`,
      }
    }
    return { itemId: id, ok: true }
  })
}
