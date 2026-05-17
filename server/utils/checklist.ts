import { z } from 'zod'
import { useBitrix24 } from '~/server/utils/bitrix24'
import {
  type ActionToolInput,
  defineActionTool,
  forceFlagSchema,
  idOrIdArraySchema,
  mapBatchRows,
} from '~/server/utils/define-action-tool'
import { Bitrix24ToolError } from '~/server/utils/errors'
import { batchV2, callV2 } from '~/server/utils/sdk-helpers'
import { pick, toBool, toNumber } from '~/server/utils/wire-coerce'
import type { BitrixChecklistItemRaw } from '~/server/types/bitrix24'

/**
 * Shared types + helpers for the five `task.checklistitem.*` tools.
 *
 * v2-only namespace — v3 has `tasks.template.checklist.*` for task templates
 * but no equivalent for tasks themselves. The five apidocs pages
 * (apidocs.bitrix24.ru/api-reference/tasks/checklist-item/*) are documented
 * and not flagged as deprecated.
 *
 * Built atop `defineActionTool` — the single-vs-batch dispatch, batch-cap
 * check, and summary projection are shared across both action-tool
 * families (lifecycle + checklist) via that scaffold.
 */

/** Subset of checklist-item fields surfaced to the agent. Mirrors what
 *  `list_tasks` does for tasks — keep the response small and predictable. */
export interface ChecklistItemShort {
  id: number
  taskId: number
  parentId: number
  title: string
  sortIndex: number
  isComplete: boolean
  isImportant: boolean
  createdBy: number | null
  toggledBy: number | null
  toggledDate: string | null
}

export function toChecklistItemShort(raw: unknown): ChecklistItemShort | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = toNumber(pick(r, 'id', 'ID'))
  const taskId = toNumber(pick(r, 'taskId', 'TASK_ID'))
  const title = pick<string>(r, 'title', 'TITLE')
  if (id === null || taskId === null || title === null) return null
  return {
    id,
    taskId,
    // parentId === 0 marks a checklist heading; the wire ships 0 as a number
    // for headings and a stringified id for nested items.
    parentId: toNumber(pick(r, 'parentId', 'PARENT_ID')) ?? 0,
    title,
    sortIndex: toNumber(pick(r, 'sortIndex', 'SORT_INDEX')) ?? 0,
    isComplete: toBool(pick(r, 'isComplete', 'IS_COMPLETE')),
    isImportant: toBool(pick(r, 'isImportant', 'IS_IMPORTANT')),
    createdBy: toNumber(pick(r, 'createdBy', 'CREATED_BY')),
    toggledBy: toNumber(pick(r, 'toggledBy', 'TOGGLED_BY')),
    // Empty string -> null so callers can tell "never toggled" from "real timestamp".
    toggledDate: pick<string>(r, 'toggledDate', 'TOGGLED_DATE') || null,
  }
}

/**
 * Factory for the three `task.checklistitem.{complete,renew,delete}` tools.
 *
 * All three take positional `[taskId, itemId]` on the wire (documented form
 * on apidocs.bitrix24.ru) and return a boolean. Single mode = one `callV2`.
 * Batch mode = one `batchV2` round-trip via `actions.v2.batch.make` (cap 50
 * per Bitrix24's server-side limit).
 *
 * For `delete` only: when the target is a checklist heading (`parentId: 0`)
 * the request wipes the whole sub-tree. To prevent silent data loss we
 * require an explicit `confirmDeleteHeading: true` for those calls — see
 * `runOne` / `runBatch`.
 */
export type ChecklistActionMethod =
  | 'task.checklistitem.complete'
  | 'task.checklistitem.renew'
  | 'task.checklistitem.delete'

export interface ChecklistActionToolSpec {
  /** MCP tool name, e.g. `bitrix24_complete_checklist_item`. */
  name: string
  /** Bitrix24 REST method. */
  method: ChecklistActionMethod
  /** Infinitive verb used in error messages, e.g. `complete`. */
  verb: string
  /** Past-tense verb used as the success payload's boolean key, e.g. `completed`. */
  pastTense: string
  /** Human-readable tool description for the LLM. */
  description: string
}

const DEFAULT_BATCH_CAP = 50
const CHECKLIST_ACTION_USAGE_NOTES =
  ` Accepts a single item id OR an array of ids (batch mode, up to ${DEFAULT_BATCH_CAP} — pass \`force: true\` to override). Batch mode goes through one HTTP round-trip and returns a \`{ batch, total, ok, failed, results }\` summary; per-id errors do not abort the batch. If the operator names the item in free text instead of an id, list the checklist first via \`bitrix24_list_checklist_items\` and match by title.`

interface ChecklistInput extends ActionToolInput {
  taskId: number
  itemId: number | number[]
  confirmDeleteHeading?: boolean
}

interface ChecklistBatchRow {
  itemId: number
  ok: boolean
  error?: string
}

/** Positional `[taskId, itemId]` tuple — the documented wire form for the
 *  three action methods. `callV2`/`batchV2` accept positional params. */
function positional(taskId: number, itemId: number): unknown[] {
  return [taskId, itemId]
}

export function defineChecklistActionTool(spec: ChecklistActionToolSpec) {
  const isDelete = spec.method === 'task.checklistitem.delete'
  return defineActionTool<ChecklistInput, ChecklistBatchRow>({
    name: spec.name,
    description: spec.description,
    usageNotes: CHECKLIST_ACTION_USAGE_NOTES,
    pastTense: spec.pastTense,
    batchCap: DEFAULT_BATCH_CAP,
    inputSchema: {
      taskId: z.number().int().positive().describe('Task id the checklist item belongs to.'),
      itemId: idOrIdArraySchema.describe(
        'Checklist item id (from `bitrix24_list_checklist_items`), or an array of item ids for batch mode. Pass a number for single-item semantics; even a one-element array (e.g. [42]) enters batch mode and returns the batch summary shape — use a plain number when you have exactly one id.',
      ),
      force: forceFlagSchema(DEFAULT_BATCH_CAP),
      // Only the delete tool surfaces this gate. Other action tools omit it
      // from the schema entirely so the LLM doesn't see an irrelevant field.
      ...(isDelete
        ? {
            confirmDeleteHeading: z
              .boolean()
              .optional()
              .describe(
                'Required when deleting a checklist HEADING (an item whose parentId is 0). Heading deletion wipes the entire checklist — heading + every child — with no undo. The tool refuses with a HEADING_DELETE_NEEDS_CONFIRM error unless you confirm. Confirm with the operator before passing true. Ignored when the target is a regular item.',
              ),
          }
        : {}),
    },
    extractIds: (input) => input.itemId,
    runOne: (input, itemId) => runOne(spec, input.taskId, itemId, input.confirmDeleteHeading ?? false),
    runBatch: (input, ids) => runBatch(spec, input.taskId, ids, input.confirmDeleteHeading ?? false),
    // Carry `taskId` into the batch summary so the agent can tell at a
    // glance which task the result rows belong to.
    batchSummaryExtras: (input) => ({ taskId: input.taskId }),
  })
}

async function runOne(spec: ChecklistActionToolSpec, taskId: number, itemId: number, confirmDeleteHeading: boolean) {
  const b24 = useBitrix24()

  if (spec.method === 'task.checklistitem.delete' && !confirmDeleteHeading) {
    await assertNotHeading(b24, taskId, itemId)
  }

  await callV2<unknown>(
    b24,
    spec.method,
    positional(taskId, itemId),
    `Failed to ${spec.verb} Bitrix24 checklist item ${itemId} on task ${taskId}`,
  )

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          [spec.pastTense]: true,
          taskId,
          itemId,
        }),
      },
    ],
  }
}

async function runBatch(
  spec: ChecklistActionToolSpec,
  taskId: number,
  itemIds: number[],
  confirmDeleteHeading: boolean,
): Promise<ChecklistBatchRow[]> {
  const b24 = useBitrix24()

  if (spec.method === 'task.checklistitem.delete' && !confirmDeleteHeading) {
    // Single pre-flight `getlist` instead of N individual `get` calls — the
    // heading check applies to the whole batch and getlist returns one
    // response with parentId for every item on the task.
    await assertBatchNoHeadings(b24, taskId, itemIds)
  }

  const rows = await batchV2<unknown>(
    b24,
    itemIds.map((id) => [spec.method, positional(taskId, id)]),
    `Failed to ${spec.verb} a batch of ${itemIds.length} checklist item(s) on task ${taskId}`,
  )

  return mapBatchRows(rows, itemIds, 'itemId', ({ id, ok, errorMessages }) => {
    if (!ok) {
      return {
        itemId: id,
        ok: false,
        error: errorMessages.join('; ') || `Failed to ${spec.verb} Bitrix24 checklist item ${id} on task ${taskId}`,
      }
    }
    return { itemId: id, ok: true }
  })
}

/**
 * Refuse to delete a checklist heading unless the agent confirmed it. Reads
 * the checklist once and matches on `parentId === 0`. If Bitrix24 returns no
 * matching item we let the delete call proceed — its own NOT_FOUND error is
 * a cleaner signal than fabricating one here.
 */
async function assertNotHeading(b24: Parameters<typeof callV2>[0], taskId: number, itemId: number): Promise<void> {
  const items = await callV2<BitrixChecklistItemRaw[]>(
    b24,
    'task.checklistitem.getlist',
    { TASKID: taskId },
    `Failed to pre-flight delete for Bitrix24 checklist item ${itemId} on task ${taskId}`,
  )
  if (!Array.isArray(items)) return
  const target = items.find((it) => toNumber(it.id ?? it.ID) === itemId)
  if (!target) return
  if ((toNumber(target.parentId ?? target.PARENT_ID) ?? 0) === 0) {
    throw new Bitrix24ToolError(
      `Item ${itemId} is a checklist HEADING on task ${taskId}; deleting it wipes the whole checklist (heading + all children) with no undo. Re-call \`bitrix24_delete_checklist_item\` with \`confirmDeleteHeading: true\` after the operator has agreed.`,
      'HEADING_DELETE_NEEDS_CONFIRM',
    )
  }
}

async function assertBatchNoHeadings(
  b24: Parameters<typeof callV2>[0],
  taskId: number,
  itemIds: number[],
): Promise<void> {
  const items = await callV2<BitrixChecklistItemRaw[]>(
    b24,
    'task.checklistitem.getlist',
    { TASKID: taskId },
    `Failed to pre-flight batch delete for Bitrix24 task ${taskId}`,
  )
  if (!Array.isArray(items)) return
  const headingIds = items
    .filter((it) => (toNumber(it.parentId ?? it.PARENT_ID) ?? 0) === 0)
    .map((it) => toNumber(it.id ?? it.ID))
    .filter((id): id is number => id !== null)
  const headingHits = itemIds.filter((id) => headingIds.includes(id))
  if (headingHits.length > 0) {
    throw new Bitrix24ToolError(
      `Batch refused: ${headingHits.join(', ')} ${headingHits.length === 1 ? 'is a checklist heading' : 'are checklist headings'} on task ${taskId}. Deleting a heading wipes the whole checklist with no undo. Re-call with \`confirmDeleteHeading: true\` after the operator has agreed, or split the batch.`,
      'HEADING_DELETE_NEEDS_CONFIRM',
    )
  }
}
